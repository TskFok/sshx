import { beforeEach, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { disconnectTerminalSession } from "./terminalSessionCleanup";

beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));

it("异步释放保存的旧 ID，不受当前会话切换影响", async () => {
  let complete!: () => void;
  invoke.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
  const instance = { sessionId: "old-session" };
  const cleanup = disconnectTerminalSession(instance.sessionId);
  instance.sessionId = "new-session";
  complete();
  await cleanup;
  expect(invoke).toHaveBeenCalledExactlyOnceWith("ssh_disconnect", { sessionId: "old-session" });
});

it("重复清理仍调用后端的幂等断开", async () => {
  await disconnectTerminalSession("closed-session");
  await disconnectTerminalSession("closed-session");
  expect(invoke.mock.calls).toEqual([
    ["ssh_disconnect", { sessionId: "closed-session" }],
    ["ssh_disconnect", { sessionId: "closed-session" }],
  ]);
});

it("保留实际断开错误供调用方处理", async () => {
  invoke.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(disconnectTerminalSession("old-session")).rejects.toThrow("cleanup failed");
});
