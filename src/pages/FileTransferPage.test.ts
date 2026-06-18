import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore, type ConnectionInfo } from "@/store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(),
  open: vi.fn(),
}));

import { FileTransferPage } from "./FileTransferPage";

const connection: ConnectionInfo = {
  id: "conn-1",
  name: "生产服务器",
  host: "example.com",
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
};

function renderFileTransferPage() {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ["/file-transfer/conn-1"] },
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          path: "/file-transfer/:connectionId",
          element: React.createElement(FileTransferPage),
        })
      )
    )
  );
}

describe("FileTransferPage", () => {
  beforeEach(() => {
    useAppStore.setState({
      connections: [connection],
      groups: [],
    });
  });

  it("does not render the page-level transfer header", () => {
    const html = renderFileTransferPage();

    expect(html).not.toContain("返回连接");
    expect(html).not.toContain("文件传输");
    expect(html).not.toContain("生产服务器");
    expect(html).not.toContain("alice@example.com:22");
    expect(html).not.toContain("连接中");
  });

  it("keeps file panel directory information visible", () => {
    const html = renderFileTransferPage();

    expect(html).toContain("本地文件");
    expect(html).toContain("远程文件");
    expect(html).toContain("加载中");
  });
});
