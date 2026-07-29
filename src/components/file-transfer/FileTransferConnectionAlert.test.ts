import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTransferConnectionAlert } from "./FileTransferConnectionAlert";

function renderAlert(
  phase: "connected" | "disconnected" | "reconnecting"
): string {
  return renderToStaticMarkup(
    React.createElement(FileTransferConnectionAlert, {
      message: "会话不存在或已断开",
      phase,
      onReconnect: () => {},
    })
  );
}

describe("FileTransferConnectionAlert", () => {
  it("普通文件操作错误不显示重新连接入口", () => {
    const html = renderAlert("connected");

    expect(html).toContain("会话不存在或已断开");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("重新连接");
  });

  it("连接失效时显示重新连接按钮", () => {
    const html = renderAlert("disconnected");

    expect(html).toContain("重新连接");
    expect(html).toContain('aria-label="重新连接文件传输"');
    expect(html).not.toContain("重新连接中");
  });

  it("重连期间禁用按钮并显示加载状态", () => {
    const html = renderAlert("reconnecting");

    expect(html).toContain("重新连接中");
    expect(html).toContain("disabled");
  });
});
