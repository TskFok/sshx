import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type ConnectionGroup, type ConnectionSummary } from "@/store";

export interface ConnectionCatalog {
  connections: ConnectionSummary[];
  groups: ConnectionGroup[];
}

let generation = 0;
let cached: ConnectionCatalog | null = null;
let inFlight: Promise<ConnectionCatalog> | null = null;

export function invalidateConnectionCatalog(): void {
  generation += 1;
  cached = null;
  inFlight = null;
}

export function loadConnectionCatalog(force = false): Promise<ConnectionCatalog> {
  if (force) invalidateConnectionCatalog();
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;

  const requestGeneration = generation;
  const request = Promise.all([
    invoke<ConnectionSummary[]>("list_connection_summaries"),
    invoke<ConnectionGroup[]>("list_groups"),
  ]).then(([connections, groups]) => {
    const catalog = { connections, groups };
    if (generation === requestGeneration) {
      cached = catalog;
      useAppStore.getState().setConnections(connections);
      useAppStore.getState().setGroups(groups);
    }
    return catalog;
  }).finally(() => {
    if (generation === requestGeneration) inFlight = null;
  });
  inFlight = request;
  return request;
}

export async function mutateConnectionCatalog<T = void>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  const result = await invoke<T>(command, args);
  invalidateConnectionCatalog();
  try {
    await loadConnectionCatalog();
  } catch (error) {
    // 写入已成功；保留代次失效状态，下一次加载可重试。
    console.error("refresh connection catalog error:", error);
  }
  return result;
}
