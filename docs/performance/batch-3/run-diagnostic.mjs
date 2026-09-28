// macOS 手动采样外层守卫；只传入本次受信配置和预先编译的测试可执行文件。
// 进程采样是观察下界，不能替代完整的资源泄漏验证。
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, createWriteStream } from 'node:fs';

const [configPath, mode, samples, executable] = process.argv.slice(2);
const tests = {
  cancel: ['benchmark_production_sftp_download_cancel', 30],
  batch: ['benchmark_production_sftp_small_batch', 5],
  concurrency: ['benchmark_production_sftp_small_concurrency', 5],
  isolation: ['benchmark_production_sftp_download_cancel_isolation', 1],
};
if (!Object.hasOwn(tests, mode)) {
  throw Error('mode must be cancel, batch, concurrency or isolation');
}
if (
  !configPath ||
  !executable ||
  !/^\d+$/.test(samples ?? '') ||
  +samples < 1 ||
  +samples > tests[mode][1]
) {
  throw Error('usage: node run-diagnostic.mjs CONFIG MODE SAMPLES TEST_EXECUTABLE');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const test = tests[mode][0];
const label = `sftp-${mode}-${Date.now()}`;
const output = `${config.outputDir}/${label}`;
const log = createWriteStream(`${output}.txt`, { flags: 'wx' });
const startedAt = new Date().toISOString();
const start = performance.now();
const env = {
  ...process.env,
  SSHX_BENCHMARK_CONFIG: configPath,
  SSHX_BENCHMARK_SAMPLES: samples,
};
for (const key of ['SSHX_BENCHMARK_LARGE', 'SSHX_BENCHMARK_DIRECTION', 'SSHX_BENCHMARK_FILES']) {
  delete env[key];
}

const args = ['-lp', executable, test, '--ignored', '--nocapture'];
log.write(JSON.stringify({
  startedAt,
  executable,
  args,
  samples: +samples,
  scope: 'production SFTP method diagnostic; no DB/IPC/UI',
}) + '\n');
// detached 在 macOS 上为本次 /usr/bin/time 及其子进程建立独立进程组。
const child = spawn('/usr/bin/time', args, {
  detached: true,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (bytes) => {
  log.write(bytes);
  process.stdout.write(bytes);
});
child.stderr.on('data', (bytes) => log.write(bytes));

const seen = new Map();
const snapshots = [];
let rootIdentity = null;
let rootExited = false;
let peakSftp = 0;
let peakRssKiB = 0;
let psError = false;
let timeout = false;
const cleanupSignals = [];

function sameIdentity(left, right) {
  return left.pid === right.pid &&
    left.birth === right.birth &&
    left.command === right.command;
}

function processRows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,lstart=,comm='], {
    encoding: 'utf8',
  }).trim().split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    return match ? [{
      pid: +match[1],
      ppid: +match[2],
      rssKiB: +match[3],
      birth: match[4],
      command: match[5],
    }] : [];
  });
}

function collect() {
  try {
    const rows = processRows();
    const ids = new Set();
    const root = rows.find((row) => row.pid === child.pid);
    if (!rootExited && child.exitCode === null && child.signalCode === null && root) {
      if (rootIdentity === null) {
        rootIdentity = root;
        seen.set(root.pid, root);
      }
      if (sameIdentity(rootIdentity, root)) {
        ids.add(root.pid);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!ids.has(row.ppid) || ids.has(row.pid)) {
          continue;
        }
        const known = seen.get(row.pid);
        if (known && !sameIdentity(known, row)) {
          continue;
        }
        if (!known) {
          seen.set(row.pid, row);
        }
        ids.add(row.pid);
        changed = true;
      }
    }

    const own = rows.filter((row) => ids.has(row.pid));
    const sftp = own.filter((row) => row.command.endsWith('/sftp')).length;
    const rssKiB = own.reduce((sum, row) => sum + row.rssKiB, 0);
    peakSftp = Math.max(peakSftp, sftp);
    peakRssKiB = Math.max(peakRssKiB, rssKiB);
    snapshots.push({ timestamp: new Date().toISOString(), sftp, rssKiB, processes: own });
    return rows;
  } catch {
    psError = true;
    return [];
  }
}

function remaining() {
  const rows = collect();
  return rows.filter((row) => {
    const known = seen.get(row.pid);
    return known && sameIdentity(known, row);
  });
}

function signalOwned(signal) {
  for (const row of remaining().reverse()) {
    try {
      process.kill(row.pid, signal);
      cleanupSignals.push({ pid: row.pid, signal });
    } catch {
      // 进程可能已在检查后退出。
    }
  }
}

const monitor = setInterval(collect, 500);
collect();
child.on('exit', () => { rootExited = true; });

let hardKill;
const deadline = setTimeout(() => {
  timeout = true;
  signalOwned('SIGTERM');
  hardKill = setTimeout(() => {
    signalOwned('SIGKILL');
    // ps 失败时仍能回收本次新进程组；root 已退出则不盲杀旧 PID。
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
        cleanupSignals.push({ processGroup: child.pid, signal: 'SIGKILL' });
      } catch {
        // 进程组可能刚好退出。
      }
    }
  }, 2000);
}, 600000);

child.on('close', async (exitCode, signal) => {
  rootExited = true;
  clearInterval(monitor);
  clearTimeout(deadline);
  if (hardKill) {
    clearTimeout(hardKill);
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  let leftover = remaining();
  if (leftover.length) {
    signalOwned('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 500));
    leftover = remaining();
    if (leftover.length) {
      signalOwned('SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 200));
      leftover = remaining();
    }
  }

  const row = {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds: (performance.now() - start) / 1000,
    exitCode,
    signal,
    mode,
    samples: +samples,
    timeout,
    psError,
    rootObserved: rootIdentity !== null,
    observedPeakSftpProcesses: peakSftp,
    observedPeakRssKiB: peakRssKiB,
    remainingObservedOwnedProcesses: leftover,
    cleanupSignals,
    notes: '500ms descendant sampling: peak is only observed lower bound; no observed remnants at finish is not proof of no leaks; excludes independently created ControlMaster and unobserved short-lived children; process identity checked with start time and executable; CPU timing includes hashing',
  };
  log.end(JSON.stringify(row) + '\n');
  writeFileSync(`${output}.json`, JSON.stringify(row, null, 2) + '\n');
  writeFileSync(`${output}-processes.jsonl`, snapshots.map((snapshot) => JSON.stringify(snapshot)).join('\n') + '\n');
  console.log(JSON.stringify(row));
  process.exitCode = timeout || psError || rootIdentity === null || leftover.length
    ? 1
    : (exitCode ?? 1);
});
