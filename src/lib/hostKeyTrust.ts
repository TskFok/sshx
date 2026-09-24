export interface HostKeyPrompt {
  requestId: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}

export interface HostKeyTrustState {
  prompts: HostKeyPrompt[];
  replying: boolean;
  error: string | null;
}

export interface HostKeyTrustTransport {
  listen: (onChanged: () => void) => Promise<() => void>;
  pending: () => Promise<HostKeyPrompt[]>;
  respond: (requestId: string, accept: boolean) => Promise<void>;
}

export function createHostKeyTrustController(transport: HostKeyTrustTransport) {
  let state: HostKeyTrustState = { prompts: [], replying: false, error: null };
  let started = false;
  let stopped = false;
  let revision = 0;
  let unlisten: (() => void) | undefined;
  const subscribers = new Set<(state: HostKeyTrustState) => void>();

  const update = (next: Partial<HostKeyTrustState>) => {
    if (stopped) return;
    state = { ...state, ...next };
    subscribers.forEach((subscriber) => subscriber(state));
  };

  const refresh = async () => {
    const currentRevision = ++revision;
    try {
      const prompts = await transport.pending();
      if (!stopped && currentRevision === revision) {
        update({ prompts, error: null });
      }
    } catch (error) {
      if (!stopped && currentRevision === revision) {
        console.error("获取待确认 SSH 主机密钥失败", error);
      }
    }
  };

  return {
    getState: () => state,
    subscribe(subscriber: (state: HostKeyTrustState) => void) {
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    async start() {
      if (started || stopped) return;
      started = true;
      try {
        const removeListener = await transport.listen(() => { void refresh(); });
        if (stopped) {
          removeListener();
          return;
        }
        unlisten = removeListener;
        await refresh();
      } catch (error) {
        if (!stopped) console.error("监听 SSH 主机密钥确认失败", error);
      }
    },
    stop() {
      if (stopped) return;
      stopped = true;
      revision++;
      unlisten?.();
      unlisten = undefined;
      subscribers.clear();
    },
    async respond(requestId: string, accept: boolean) {
      const prompt = state.prompts[0];
      if (stopped || !prompt || prompt.requestId !== requestId || state.replying) return;
      update({ replying: true, error: null });
      try {
        await transport.respond(prompt.requestId, accept);
        if (stopped) return;
        // A snapshot requested before this reply must not restore the resolved prompt.
        revision++;
        update({
          prompts: state.prompts.filter((item) => item.requestId !== prompt.requestId),
          error: null,
        });
        await refresh();
      } catch (error) {
        if (!stopped && state.prompts[0]?.requestId === prompt.requestId) {
          update({ error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (!stopped) update({ replying: false });
      }
    },
  };
}
