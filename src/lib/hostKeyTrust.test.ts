import { describe, expect, it } from "vitest";
import {
  createHostKeyTrustController,
  type HostKeyPrompt,
} from "./hostKeyTrust";

const first: HostKeyPrompt = {
  requestId: "first",
  host: "one.example",
  port: 22,
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:first",
};
const second: HostKeyPrompt = {
  requestId: "second",
  host: "two.example",
  port: 2222,
  algorithm: "ecdsa-sha2-nistp256",
  fingerprint: "SHA256:second",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("host key trust controller", () => {
  it("注册监听后获取快照，取消首个请求只发送拒绝并依次显示下一项", async () => {
    let changed: (() => void) | undefined;
    const responses: { requestId: string; accept: boolean }[] = [];
    let pending = [first, second];
    const controller = createHostKeyTrustController({
      listen: async (callback) => { changed = callback; return () => {}; },
      pending: async () => pending,
      respond: async (requestId, accept) => {
        responses.push({ requestId, accept });
        pending = pending.filter((item) => item.requestId !== requestId);
      },
    });

    await controller.start();
    expect(changed).toBeTypeOf("function");
    expect(controller.getState().prompts.map((item) => item.requestId)).toEqual(["first", "second"]);

    await controller.respond("first", false);
    expect(responses).toEqual([{ requestId: "first", accept: false }]);
    expect(controller.getState().prompts[0]?.requestId).toBe("second");

    await controller.respond("second", true);
    expect(responses).toEqual([
      { requestId: "first", accept: false },
      { requestId: "second", accept: true },
    ]);
    expect(controller.getState().prompts).toEqual([]);
  });

  it("变更事件刷新后丢弃较晚返回的旧快照，包括已过期请求", async () => {
    let changed: (() => void) | undefined;
    const oldSnapshot = deferred<HostKeyPrompt[]>();
    let calls = 0;
    const controller = createHostKeyTrustController({
      listen: async (callback) => { changed = callback; return () => {}; },
      pending: () => ++calls === 1 ? oldSnapshot.promise : Promise.resolve([second]),
      respond: async () => {},
    });

    const starting = controller.start();
    await Promise.resolve();
    changed?.();
    await Promise.resolve();
    expect(controller.getState().prompts).toEqual([second]);

    oldSnapshot.resolve([first]);
    await starting;
    expect(controller.getState().prompts).toEqual([second]);
  });

  it("卸载发生在监听注册期间时立即解除监听，忽略之后的快照", async () => {
    const registration = deferred<() => void>();
    let unlistenCount = 0;
    let pendingCalls = 0;
    const controller = createHostKeyTrustController({
      listen: async () => registration.promise,
      pending: async () => { pendingCalls++; return [first]; },
      respond: async () => {},
    });

    const starting = controller.start();
    controller.stop();
    registration.resolve(() => { unlistenCount++; });
    await starting;
    expect(unlistenCount).toBe(1);
    expect(pendingCalls).toBe(0);
    expect(controller.getState().prompts).toEqual([]);
  });

  it("后端超时清理并发出变更事件后关闭当前请求", async () => {
    let changed: (() => void) | undefined;
    let pending = [first];
    const controller = createHostKeyTrustController({
      listen: async (callback) => { changed = callback; return () => {}; },
      pending: async () => pending,
      respond: async () => {},
    });
    await controller.start();
    expect(controller.getState().prompts).toEqual([first]);

    pending = [];
    changed?.();
    await Promise.resolve();
    expect(controller.getState().prompts).toEqual([]);
  });

  it("旧弹窗的回复不能授权已成为队首的下一个请求", async () => {
    let changed: (() => void) | undefined;
    let pending = [first, second];
    const responses: { requestId: string; accept: boolean }[] = [];
    const controller = createHostKeyTrustController({
      listen: async (callback) => { changed = callback; return () => {}; },
      pending: async () => pending,
      respond: async (requestId, accept) => { responses.push({ requestId, accept }); },
    });
    await controller.start();

    pending = [second];
    changed?.();
    await Promise.resolve();
    expect(controller.getState().prompts[0]?.requestId).toBe("second");

    await controller.respond("first", true);
    expect(responses).toEqual([]);
    expect(controller.getState().prompts[0]?.requestId).toBe("second");
  });

  it("重复提交期间只调用一次后端，错误留在当前请求供用户处理", async () => {
    const reply = deferred<void>();
    let responses = 0;
    const controller = createHostKeyTrustController({
      listen: async () => () => {},
      pending: async () => [first],
      respond: async () => { responses++; await reply.promise; throw new Error("确认请求已失效"); },
    });
    await controller.start();

    const firstAttempt = controller.respond("first", true);
    await controller.respond("first", false);
    expect(responses).toBe(1);
    reply.resolve();
    await firstAttempt;
    expect(controller.getState().prompts).toEqual([first]);
    expect(controller.getState().error).toContain("确认请求已失效");
  });

  it("回复失败时若原请求已过期，不把错误显示在下一个请求上", async () => {
    let changed: (() => void) | undefined;
    let pending = [first, second];
    const reply = deferred<void>();
    const controller = createHostKeyTrustController({
      listen: async (callback) => { changed = callback; return () => {}; },
      pending: async () => pending,
      respond: async () => { await reply.promise; throw new Error("原请求已过期"); },
    });
    await controller.start();

    const replying = controller.respond("first", true);
    pending = [second];
    changed?.();
    await Promise.resolve();
    reply.resolve();
    await replying;

    expect(controller.getState().prompts).toEqual([second]);
    expect(controller.getState().error).toBeNull();
  });
});
