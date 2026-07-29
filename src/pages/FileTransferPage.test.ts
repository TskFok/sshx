import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Server } from "lucide-react";
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

import {
  FilePanel,
  FileTransferConnectionPicker,
  FileTransferPage,
  HistoryRow,
} from "./FileTransferPage";

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

const ungroupedConnection: ConnectionInfo = {
  ...connection,
  id: "conn-2",
  name: "未分组服务器",
  host: "ungrouped.example.com",
  groupId: null,
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

function renderFileTransferConnectionPicker() {
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(FileTransferConnectionPicker, {
        connections: [
          { ...connection, groupId: "prod" },
          ungroupedConnection,
        ],
        groups: [
          { id: "prod", name: "生产", color: "#ef4444", sortOrder: 0 },
          { id: "empty", name: "空分组", color: "#22c55e", sortOrder: 1 },
        ],
        loading: false,
      })
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

  it("不在详情内容区渲染返回文件传输连接列表按钮", () => {
    const html = renderFileTransferPage();

    expect(html).not.toContain("返回列表");
    expect(html).not.toContain('aria-label="返回文件传输连接列表"');
  });

  it("renders a connection picker when no connection is selected", () => {
    const html = renderFileTransferConnectionPicker();

    expect(html).toContain("选择连接进行文件传输");
    expect(html.indexOf("生产")).toBeLessThan(html.indexOf("生产服务器"));
    expect(html).toContain("生产服务器");
    expect(html).toContain("alice@example.com:22");
    expect(html).toContain('href="/file-transfer/conn-1"');
    expect(html.indexOf("未分组")).toBeLessThan(html.indexOf("未分组服务器"));
    expect(html).toContain("未分组服务器");
    expect(html).toContain('href="/file-transfer/conn-2"');
    expect(html).not.toContain("空分组");
    expect(html).not.toContain("本地文件");
    expect(html).not.toContain("远程文件");
  });

  it("renders permissions in the remote file panel", () => {
    const html = renderToStaticMarkup(
      React.createElement(FilePanel, {
        title: "远程文件",
        icon: Server,
        snapshot: {
          cwd: "/home/alice",
          entries: [
            {
              name: "secret.tar",
              path: "/home/alice/secret.tar",
              isDirectory: false,
              size: 1024,
              modifiedAt: null,
              permissions: "-rw-------",
            },
          ],
        },
        loading: false,
        selectedPaths: [],
        pathValue: "/home/alice",
        onPathChange: () => {},
        onPathSubmit: () => {},
        pathDisabled: false,
        pathSubmitDisabled: false,
        searchValue: "",
        onSearchChange: () => {},
        onSelect: () => {},
        onRefresh: () => {},
        onParent: () => {},
        parentDisabled: false,
        footer: null,
        showPermissions: true,
      })
    );

    expect(html).toContain("-rw-------");
  });

  it("连接不可用时禁用远程文件面板交互", () => {
    const html = renderToStaticMarkup(
      React.createElement(FilePanel, {
        title: "远程文件",
        icon: Server,
        snapshot: {
          cwd: "/home/alice",
          entries: [
            {
              name: "secret.tar",
              path: "/home/alice/secret.tar",
              isDirectory: false,
              size: 1024,
              modifiedAt: null,
              permissions: "-rw-------",
            },
          ],
        },
        loading: false,
        selectedPaths: [],
        pathValue: "/home/alice",
        onPathChange: () => {},
        onPathSubmit: () => {},
        pathDisabled: true,
        pathSubmitDisabled: true,
        searchValue: "",
        onSearchChange: () => {},
        onSelect: () => {},
        onRefresh: () => {},
        onParent: () => {},
        parentDisabled: false,
        footer: null,
        showPermissions: true,
        interactionDisabled: true,
      })
    );

    expect(html).toContain(
      'aria-label="远程文件搜索当前目录" disabled=""'
    );
    expect(html).toContain(
      'aria-label="选择文件 secret.tar" disabled=""'
    );
  });

  it("renders separate search inputs for local and remote panels", () => {
    const html = renderFileTransferPage();

    expect(html).toContain('aria-label="本地文件搜索当前目录"');
    expect(html).toContain('aria-label="远程文件搜索当前目录"');
  });

  it("renders editable current directory address bars for local and remote panels", () => {
    const html = renderFileTransferPage();

    expect(html).toContain('aria-label="本地文件当前目录地址栏"');
    expect(html).toContain('aria-label="远程文件当前目录地址栏"');
    expect(html).not.toContain('aria-label="本地文件手动输入目录路径"');
    expect(html).not.toContain('aria-label="远程文件手动输入目录路径"');
    expect(html).not.toContain(
      '<p class="truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">'
    );
  });

  it("renders path jump actions for local and remote panels", () => {
    const html = renderFileTransferPage();

    expect(html).toContain('aria-label="本地文件跳转到输入目录"');
    expect(html).toContain('aria-label="远程文件跳转到输入目录"');
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

  it("连接不可用时禁用传输历史中的远程目录跳转", () => {
    const html = renderToStaticMarkup(
      React.createElement(HistoryRow, {
        name: "large.tar",
        direction: "upload",
        status: "failed",
        localDir: "/tmp",
        remoteDir: "/home/alice",
        totalBytes: 1024,
        progress: 25,
        speedBps: 128,
        durationMs: null,
        errorMessage: "会话不存在或已断开",
        onLocalDir: () => {},
        onRemoteDir: () => {},
        remoteDirDisabled: true,
      })
    );

    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>远程：\/home\/alice<\/button>/
    );
  });
});
