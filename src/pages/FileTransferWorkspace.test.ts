import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConnectionInfo } from "@/store";
import { FileTransferTabBar } from "./FileTransferWorkspace";

const connections: ConnectionInfo[] = [
  {
    id: "conn-1",
    name: "生产服务器",
    host: "prod.example.com",
    port: 22,
    username: "alice",
    authType: "password",
    password: null,
    privateKey: null,
    privateKeyPassphrase: null,
    groupId: null,
    keepaliveIntervalSecs: 0,
    keepaliveMax: 0,
    isImportant: false,
    createdAt: 0,
    updatedAt: 0,
    sortOrder: 0,
  },
  {
    id: "conn-2",
    name: "测试服务器",
    host: "test.example.com",
    port: 22,
    username: "bob",
    authType: "password",
    password: null,
    privateKey: null,
    privateKeyPassphrase: null,
    groupId: null,
    keepaliveIntervalSecs: 0,
    keepaliveMax: 0,
    isImportant: false,
    createdAt: 0,
    updatedAt: 0,
    sortOrder: 1,
  },
];

describe("FileTransferTabBar", () => {
  it("显示打开连接、关闭操作和终端一致的 Shift 关闭提示", () => {
    const html = renderToStaticMarkup(
      React.createElement(FileTransferTabBar, {
        connections,
        openConnectionIds: ["conn-1", "conn-2"],
        activeConnectionId: "conn-1",
        onSelect: () => {},
        onClose: () => {},
        onReturnToList: () => {},
      })
    );

    expect(html).toContain("生产服务器");
    expect(html).toContain("测试服务器");
    expect(html).toContain("返回列表");
    expect(html).toContain('aria-label="返回文件传输连接列表"');
    expect(html).toContain('aria-label="关闭文件传输 conn-1"');
    expect(html).toContain("单击切换标签 · Shift+单击关闭");
  });
});
