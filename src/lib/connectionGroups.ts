import type { ConnectionGroup, ConnectionInfo } from "@/store";

export interface ConnectionDisplaySection {
  id: string;
  title: string;
  color: string | null;
  connections: ConnectionInfo[];
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
