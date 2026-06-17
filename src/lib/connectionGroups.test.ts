import { describe, expect, it } from "vitest";
import type { ConnectionGroup, ConnectionInfo } from "@/store";
import {
  CONNECTIONS_COLLAPSED_GROUPS_STORAGE_KEY,
  canDropConnectionDragPayload,
  canDropGroupDragPayload,
  getConnectionAccordionSections,
  groupConnectionsForDisplay,
  isConnectionSortingDisabled,
  moveItemById,
  readCollapsedGroupIds,
  reorderConnectionsWithinGroup,
  writeCollapsedGroupIds,
} from "./connectionGroups";

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
  isImportant: false,
  createdAt: 1,
  updatedAt: 1,
  sortOrder: 1,
});

const groups: ConnectionGroup[] = [
  { id: "prod", name: "生产", color: "#ef4444", sortOrder: 0 },
  { id: "test", name: "测试", color: "#22c55e", sortOrder: 1 },
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

describe("getConnectionAccordionSections", () => {
  it("为收起的分组保留标题和数量，但隐藏连接列表", () => {
    const sections = groupConnectionsForDisplay(
      [
        makeConnection("a", "生产一", "prod"),
        makeConnection("b", "测试一", "test"),
      ],
      groups
    );

    const result = getConnectionAccordionSections(sections, new Set(["prod"]));

    expect(result).toMatchObject([
      {
        id: "prod",
        title: "生产",
        isCollapsed: true,
        connectionCount: 1,
        visibleConnections: [],
      },
      {
        id: "test",
        title: "测试",
        isCollapsed: false,
        connectionCount: 1,
      },
    ]);
    expect(result[1].visibleConnections.map((c) => c.id)).toEqual(["b"]);
  });
});

describe("moveItemById", () => {
  it("按 id 将项目移动到目标项位置", () => {
    expect(moveItemById(["a", "b", "c"], "c", "a", (id) => id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("缺少拖动项或目标项时返回原数组", () => {
    const input = ["a", "b", "c"];
    expect(moveItemById(input, "x", "a", (id) => id)).toBe(input);
    expect(moveItemById(input, "a", "x", (id) => id)).toBe(input);
  });
});

describe("reorderConnectionsWithinGroup", () => {
  it("仅重排同一分组内的连接", () => {
    const input = [
      makeConnection("a", "生产一", "prod"),
      makeConnection("b", "测试一", "test"),
      makeConnection("c", "生产二", "prod"),
      makeConnection("d", "未分组一", null),
    ];

    const result = reorderConnectionsWithinGroup(input, "prod", "c", "a");

    expect(result.map((c) => c.id)).toEqual(["c", "b", "a", "d"]);
    expect(result.map((c) => c.groupId)).toEqual(["prod", "test", "prod", null]);
  });

  it("支持未分组连接的组内排序", () => {
    const input = [
      makeConnection("a", "未分组一", null),
      makeConnection("b", "生产一", "prod"),
      makeConnection("c", "未分组二", null),
    ];

    const result = reorderConnectionsWithinGroup(input, null, "c", "a");

    expect(result.map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("跨分组拖动输入不改变连接顺序", () => {
    const input = [
      makeConnection("a", "生产一", "prod"),
      makeConnection("b", "测试一", "test"),
    ];

    expect(reorderConnectionsWithinGroup(input, "prod", "a", "b")).toBe(input);
  });
});

describe("connection drag sorting state", () => {
  it("搜索关键词存在时禁用拖动排序", () => {
    expect(isConnectionSortingDisabled("")).toBe(false);
    expect(isConnectionSortingDisabled("   ")).toBe(false);
    expect(isConnectionSortingDisabled("prod")).toBe(true);
  });

  it("读写收起分组 id，并清理已不存在的分组", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    writeCollapsedGroupIds(storage, new Set(["prod", "missing"]));

    expect(values.has(CONNECTIONS_COLLAPSED_GROUPS_STORAGE_KEY)).toBe(true);
    expect(readCollapsedGroupIds(storage, new Set(["prod", "test"]))).toEqual(
      new Set(["prod"])
    );
  });
});

describe("pointer drag drop validation", () => {
  it("分组只能投放到其他真实分组上", () => {
    expect(canDropGroupDragPayload({ type: "group", id: "prod" }, "test")).toBe(
      true
    );
    expect(canDropGroupDragPayload({ type: "group", id: "prod" }, "prod")).toBe(
      false
    );
    expect(
      canDropGroupDragPayload({ type: "group", id: "prod" }, "ungrouped")
    ).toBe(false);
    expect(
      canDropGroupDragPayload(
        { type: "connection", id: "a", groupId: "prod" },
        "test"
      )
    ).toBe(false);
  });

  it("连接只能投放到同组的其他连接上", () => {
    expect(
      canDropConnectionDragPayload(
        { type: "connection", id: "a", groupId: "prod" },
        "prod",
        "b"
      )
    ).toBe(true);
    expect(
      canDropConnectionDragPayload(
        { type: "connection", id: "a", groupId: "prod" },
        "test",
        "b"
      )
    ).toBe(false);
    expect(
      canDropConnectionDragPayload(
        { type: "connection", id: "a", groupId: null },
        null,
        "a"
      )
    ).toBe(false);
    expect(
      canDropConnectionDragPayload({ type: "group", id: "prod" }, "prod", "b")
    ).toBe(false);
  });
});
