import type { ConnectionGroup, ConnectionInfo } from "@/store";

export const CONNECTIONS_COLLAPSED_GROUPS_STORAGE_KEY =
  "sshx:connections:collapsedGroupIds";

export interface CollapsedGroupStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type ConnectionDragPayload =
  | { type: "group"; id: string }
  | { type: "connection"; id: string; groupId: string | null };

export interface ConnectionDisplaySection {
  id: string;
  title: string;
  color: string | null;
  connections: ConnectionInfo[];
}

export interface ConnectionAccordionSection extends ConnectionDisplaySection {
  isCollapsed: boolean;
  connectionCount: number;
  visibleConnections: ConnectionInfo[];
}

export function groupConnectionsForDisplay(
  connections: ConnectionInfo[],
  groups: ConnectionGroup[]
): ConnectionDisplaySection[] {
  const connectionsByGroup = new Map<string, ConnectionInfo[]>();
  const groupIds = new Set(groups.map((group) => group.id));
  const ungroupedConnections: ConnectionInfo[] = [];

  for (const group of groups) {
    connectionsByGroup.set(group.id, []);
  }

  for (const connection of connections) {
    if (connection.groupId && groupIds.has(connection.groupId)) {
      connectionsByGroup.get(connection.groupId)?.push(connection);
    } else {
      ungroupedConnections.push(connection);
    }
  }

  const sections: ConnectionDisplaySection[] = groups
    .map((group) => ({
      id: group.id,
      title: group.name,
      color: group.color,
      connections: connectionsByGroup.get(group.id) ?? [],
    }))
    .filter((section) => section.connections.length > 0);

  if (ungroupedConnections.length > 0) {
    sections.push({
      id: "ungrouped",
      title: "未分组",
      color: null,
      connections: ungroupedConnections,
    });
  }

  return sections;
}

export function getConnectionAccordionSections(
  sections: ConnectionDisplaySection[],
  collapsedSectionIds: ReadonlySet<string>
): ConnectionAccordionSection[] {
  return sections.map((section) => {
    const isCollapsed = collapsedSectionIds.has(section.id);

    return {
      ...section,
      isCollapsed,
      connectionCount: section.connections.length,
      visibleConnections: isCollapsed ? [] : section.connections,
    };
  });
}

export function moveItemById<T>(
  items: T[],
  activeId: string,
  overId: string,
  getId: (item: T) => string
): T[] {
  if (activeId === overId) {
    return items;
  }

  const fromIndex = items.findIndex((item) => getId(item) === activeId);
  const toIndex = items.findIndex((item) => getId(item) === overId);

  if (fromIndex < 0 || toIndex < 0) {
    return items;
  }

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

export function reorderConnectionsWithinGroup(
  connections: ConnectionInfo[],
  groupId: string | null,
  activeId: string,
  overId: string
): ConnectionInfo[] {
  const groupConnections = connections.filter((connection) =>
    groupId === null
      ? connection.groupId === null
      : connection.groupId === groupId
  );
  const reorderedGroupConnections = moveItemById(
    groupConnections,
    activeId,
    overId,
    (connection) => connection.id
  );

  if (reorderedGroupConnections === groupConnections) {
    return connections;
  }

  const reorderedIds = new Set(reorderedGroupConnections.map((c) => c.id));
  if (!reorderedIds.has(activeId) || !reorderedIds.has(overId)) {
    return connections;
  }

  const queue = [...reorderedGroupConnections];
  return connections.map((connection) => {
    if (
      groupId === null
        ? connection.groupId === null
        : connection.groupId === groupId
    ) {
      return queue.shift() ?? connection;
    }
    return connection;
  });
}

export function isConnectionSortingDisabled(search: string): boolean {
  return search.trim().length > 0;
}

export function readCollapsedGroupIds(
  storage: CollapsedGroupStorage,
  validGroupIds: ReadonlySet<string>
): Set<string> {
  const raw = storage.getItem(CONNECTIONS_COLLAPSED_GROUPS_STORAGE_KEY);
  if (!raw) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }

    return new Set(
      parsed.filter((id): id is string => {
        return typeof id === "string" && validGroupIds.has(id);
      })
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedGroupIds(
  storage: CollapsedGroupStorage,
  groupIds: ReadonlySet<string>
): void {
  storage.setItem(
    CONNECTIONS_COLLAPSED_GROUPS_STORAGE_KEY,
    JSON.stringify([...groupIds])
  );
}

export function canDropGroupDragPayload(
  payload: ConnectionDragPayload,
  targetGroupId: string
): boolean {
  return (
    payload.type === "group" &&
    targetGroupId !== "ungrouped" &&
    payload.id !== targetGroupId
  );
}

export function canDropConnectionDragPayload(
  payload: ConnectionDragPayload,
  targetGroupId: string | null,
  targetConnectionId: string
): boolean {
  return (
    payload.type === "connection" &&
    payload.groupId === targetGroupId &&
    payload.id !== targetConnectionId
  );
}
