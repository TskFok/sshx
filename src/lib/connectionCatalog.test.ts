import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type ConnectionSummary } from "@/store";
import { invalidateConnectionCatalog, loadConnectionCatalog, mutateConnectionCatalog } from "./connectionCatalog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const summary = (id: string): ConnectionSummary => ({
  id, name: id, host: "example.com", port: 22, username: "root",
  authType: "password", groupId: null, keepaliveIntervalSecs: 30,
  keepaliveMax: 3, isImportant: false, createdAt: 1, updatedAt: 1,
  sortOrder: 0,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  invalidateConnectionCatalog();
  useAppStore.getState().setConnections([]);
  useAppStore.getState().setGroups([]);
  vi.mocked(invoke).mockReset();
});

describe("connection catalog", () => {
  it("shares one in-flight load across callers and stores credential-free summaries", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "list_connection_summaries" ? [summary("one")] : []
    );
    const first = loadConnectionCatalog();
    const second = loadConnectionCatalog();
    const third = loadConnectionCatalog();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await first;
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith("list_connection_summaries");
    expect(invoke).toHaveBeenCalledWith("list_groups");
    expect(useAppStore.getState().connections[0]).not.toHaveProperty("password");
  });

  it("ignores an old request that finishes after invalidation", async () => {
    const old = deferred<ConnectionSummary[]>();
    const fresh = deferred<ConnectionSummary[]>();
    let summaryCalls = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "list_groups") return Promise.resolve([]);
      summaryCalls += 1;
      return summaryCalls === 1 ? old.promise : fresh.promise;
    });
    const oldLoad = loadConnectionCatalog();
    invalidateConnectionCatalog();
    const newLoad = loadConnectionCatalog();
    fresh.resolve([summary("new")]);
    await newLoad;
    old.resolve([summary("old")]);
    await oldLoad;
    expect(useAppStore.getState().connections.map((item) => item.id)).toEqual(["new"]);
  });

  it("retries after a rejected load without clearing the previous catalog", async () => {
    useAppStore.getState().setConnections([summary("cached")]);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("database busy"));
    await expect(loadConnectionCatalog()).rejects.toThrow("database busy");
    expect(useAppStore.getState().connections[0].id).toBe("cached");
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "list_connection_summaries" ? [summary("recovered")] : []
    );
    await loadConnectionCatalog();
    expect(useAppStore.getState().connections[0].id).toBe("recovered");
  });

  it.each([
    "create_connection", "update_connection", "delete_connection",
    "reorder_connections", "create_group", "update_group",
    "delete_group", "reorder_groups", "import_connections_file",
  ])("refreshes after successful %s", async (command) => {
    let listCalls = 0;
    vi.mocked(invoke).mockImplementation(async (name) => {
      if (name === "list_connection_summaries") return [summary(`version-${++listCalls}`)];
      if (name === "list_groups") return [];
      return undefined;
    });
    await loadConnectionCatalog();
    await mutateConnectionCatalog(command, { request: {} });
    expect(listCalls).toBe(2);
    expect(useAppStore.getState().connections[0].id).toBe("version-2");
  });

  it("keeps the cached catalog when a mutation fails", async () => {
    vi.mocked(invoke).mockImplementation(async (name) => {
      if (name === "list_connection_summaries") return [summary("cached")];
      if (name === "list_groups") return [];
      throw new Error("write failed");
    });
    const cached = await loadConnectionCatalog();
    await expect(mutateConnectionCatalog("delete_connection", { id: "cached" })).rejects.toThrow("write failed");
    expect(await loadConnectionCatalog()).toBe(cached);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("keeps the successful write result when its refresh fails, then retries the catalog", async () => {
    let listCalls = 0;
    let writes = 0;
    vi.mocked(invoke).mockImplementation(async (name) => {
      if (name === "list_connection_summaries") {
        listCalls += 1;
        if (listCalls === 2) throw new Error("refresh failed");
        return [summary(listCalls === 1 ? "before" : "after")];
      }
      if (name === "list_groups") return [];
      writes += 1;
      return "saved";
    });
    await loadConnectionCatalog();
    await expect(mutateConnectionCatalog<string>("reorder_connections", { request: {} }))
      .resolves.toBe("saved");
    expect(writes).toBe(1);
    expect(useAppStore.getState().connections[0].id).toBe("before");
    await loadConnectionCatalog();
    expect(useAppStore.getState().connections[0].id).toBe("after");
  });

  it("does not let a pre-reorder load overwrite its successful refresh", async () => {
    const old = deferred<ConnectionSummary[]>();
    let summaryCalls = 0;
    vi.mocked(invoke).mockImplementation(async (name) => {
      if (name === "list_connection_summaries") {
        summaryCalls += 1;
        return summaryCalls === 1 ? old.promise : [summary("reordered")];
      }
      if (name === "list_groups") return [];
      return undefined;
    });
    const preReorderLoad = loadConnectionCatalog();
    await mutateConnectionCatalog("reorder_connections", { request: {} });
    old.resolve([summary("old-order")]);
    await preReorderLoad;
    expect(useAppStore.getState().connections.map((item) => item.id)).toEqual(["reordered"]);
  });
});
