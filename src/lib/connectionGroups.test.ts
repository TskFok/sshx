import { describe, expect, it } from "vitest";
import type { ConnectionGroup, ConnectionInfo } from "@/store";
import { groupConnectionsForDisplay } from "./connectionGroups";

const makeConnection = (
  id: string,
  name: string,
  groupId: string | null
): ConnectionInfo => ({
  id,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authType: "password",
  password: null,
  privateKey: null,
  privateKeyPassphrase: null,
  groupId,
  keepaliveIntervalSecs: 30,
  keepaliveMax: 3,
  createdAt: 1,
  updatedAt: 1,
});

const groups: ConnectionGroup[] = [
  { id: "prod", name: "生产", color: "#ef4444" },
  { id: "test", name: "测试", color: "#22c55e" },
];

describe("groupConnectionsForDisplay", () => {
  it("按已有分组拆分连接，并将无分组连接放入未分组", () => {
    const result = groupConnectionsForDisplay(
      [
        makeConnection("a", "生产一", "prod"),
        makeConnection("b", "未分组一", null),
        makeConnection("c", "测试一", "test"),
        makeConnection("d", "生产二", "prod"),
      ],
      groups
    );

    expect(result.map((section) => section.title)).toEqual([
      "生产",
      "测试",
      "未分组",
    ]);
    expect(
      result.map((section) => section.connections.map((c) => c.id))
    ).toEqual([["a", "d"], ["c"], ["b"]]);
  });

  it("忽略没有连接的空分组", () => {
    const result = groupConnectionsForDisplay(
      [makeConnection("a", "生产一", "prod")],
      groups
    );

    expect(result.map((section) => section.title)).toEqual(["生产"]);
  });

  it("分组不存在的连接归入未分组", () => {
    const result = groupConnectionsForDisplay(
      [makeConnection("a", "未知分组连接", "missing")],
      groups
    );

    expect(result).toMatchObject([
      {
        id: "ungrouped",
        title: "未分组",
        color: null,
      },
    ]);
    expect(result[0].connections.map((c) => c.id)).toEqual(["a"]);
  });
});
