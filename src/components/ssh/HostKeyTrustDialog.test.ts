import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HostKeyTrustContent } from "./HostKeyTrustDialog";
import { Dialog } from "@/components/ui/dialog";

const prompt = {
  requestId: "sample",
  host: "example.com",
  port: 2222,
  algorithm: "ssh-ed25519",
  fingerprint: "SHA256:aBcDeFg123",
};

function renderContent(verified: boolean, busy = false, error: string | null = null) {
  return renderToStaticMarkup(React.createElement(Dialog, { open: true },
    React.createElement(HostKeyTrustContent, {
      prompt, verified, busy, error,
      onVerifiedChange: () => {}, onCancel: () => {}, onAccept: () => {},
    })
  ));
}

function trustButton(html: string) {
  return html.match(/<button[^>]*>信任并连接<\/button>/)?.[0];
}

describe("HostKeyTrustContent", () => {
  it("显示主机、端口、算法、完整 SHA256 指纹及独立核验提示", () => {
    const html = renderContent(false);
    expect(html).toContain("example.com");
    expect(html).toContain("2222");
    expect(html).toContain("ssh-ed25519");
    expect(html).toContain("SHA256:aBcDeFg123");
    expect(html).toContain("独立渠道核验");
    expect(html).toContain("取消");
  });

  it("未核验或提交中时禁用信任按钮，后端错误可见", () => {
    expect(trustButton(renderContent(false))).toContain(' disabled=""');
    expect(trustButton(renderContent(true, true))).toContain(' disabled=""');
    expect(renderContent(true, false, "确认失败")).toContain("确认失败");
    expect(trustButton(renderContent(true))).not.toContain(' disabled=""');
  });
});
