import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/store";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  beforeEach(() => {
    useAppStore.setState({ sidebarCollapsed: false });
  });

  it("renders the file transfer entry below connection management", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(Sidebar)
      )
    );

    const connectionsIndex = html.indexOf("连接管理");
    const fileTransferIndex = html.indexOf("文件传输");

    expect(connectionsIndex).toBeGreaterThanOrEqual(0);
    expect(fileTransferIndex).toBeGreaterThan(connectionsIndex);
    expect(html).toContain('href="/file-transfer"');
  });
});
