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

import { FileTransferPage, HistoryRow } from "./FileTransferPage";

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

  it("renders separate search inputs for local and remote panels", () => {
    const html = renderFileTransferPage();

    expect(html).toContain('aria-label="本地文件搜索当前目录"');
    expect(html).toContain('aria-label="远程文件搜索当前目录"');
  });

  it("renders transfer actions with selected file counts", () => {
    const html = renderFileTransferPage();

    expect(html).toContain("上传 0 个文件");
    expect(html).toContain("下载 0 个文件");
  });

  it("renders a cancel action for a running transfer row", () => {
    const html = renderToStaticMarkup(
      React.createElement(HistoryRow, {
        name: "large.tar",
        direction: "upload",
        status: "running",
        localDir: "/tmp",
        remoteDir: "/home/alice",
        totalBytes: 1024,
        progress: 25,
        speedBps: 128,
        durationMs: null,
        errorMessage: null,
        onLocalDir: () => {},
        onRemoteDir: () => {},
        onCancelTransfer: () => {},
        cancelDisabled: false,
      })
    );

    expect(html).toContain("中断");
    expect(html).toContain('aria-label="中断传输 large.tar"');
  });
});
