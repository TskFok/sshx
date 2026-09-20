import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type CspMap = Record<string, string>;

const tauriConfig = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")
) as {
  app: {
    security: {
      csp: CspMap | null;
      devCsp?: CspMap | null;
    };
  };
};

function assertDirectiveMap(value: unknown, label: string): CspMap {
  expect(value, `${label} 必须是对象`).toBeTruthy();
  expect(value, label).toBeTypeOf("object");
  expect(Array.isArray(value), `${label} 不能是数组`).toBe(false);
  return value as CspMap;
}

function tokens(directive: string | undefined, label: string): string[] {
  if (typeof directive !== "string") {
    throw new Error(`${label} 必须是字符串`);
  }
  return directive.split(/\s+/).filter(Boolean);
}

describe("tauri CSP", () => {
  const security = tauriConfig.app.security;
  const csp = assertDirectiveMap(security.csp, "app.security.csp");
  const devCsp = assertDirectiveMap(security.devCsp, "app.security.devCsp");
  const scriptSrc = tokens(csp["script-src"], "csp.script-src");
  const styleSrc = tokens(csp["style-src"], "csp.style-src");
  const imgSrc = tokens(csp["img-src"], "csp.img-src");
  const connectSrc = tokens(csp["connect-src"], "csp.connect-src");
  const devScriptSrc = tokens(devCsp["script-src"], "devCsp.script-src");
  const devConnectSrc = tokens(devCsp["connect-src"], "devCsp.connect-src");

  it("csp 与 devCsp 均为对象且不为 null", () => {
    expect(csp).toEqual(expect.any(Object));
    expect(devCsp).toEqual(expect.any(Object));
  });

  it("生产 script-src 仅为本地脚本，不含 eval、内联脚本或远程 http(s)", () => {
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(
      scriptSrc.filter((token) => token.startsWith("http:") || token.startsWith("https:"))
    ).toEqual([]);
  });

  it("生产 style-src 允许内联样式与本地样式", () => {
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(styleSrc).toContain("'self'");
  });

  it("生产 img-src 覆盖 asset 协议与 Windows asset.localhost", () => {
    expect(imgSrc).toContain("asset:");
    expect(imgSrc).toContain("http://asset.localhost");
    expect(imgSrc).toContain("https://asset.localhost");
  });

  it("生产 connect-src 仅服务 Tauri IPC", () => {
    expect(connectSrc).toContain("ipc:");
    expect(connectSrc).toContain("http://ipc.localhost");
  });

  it("生产禁止插件对象与 iframe", () => {
    expect(csp["object-src"]).toBe("'none'");
    expect(csp["frame-src"]).toBe("'none'");
  });

  it("devCsp.script-src 允许 Vite HMR 所需的 eval 与本机开发源", () => {
    expect(devScriptSrc).toContain("'unsafe-eval'");
    expect(devScriptSrc).toContain("http://localhost:1420");
  });

  it("devCsp.connect-src 允许本机 HTTP 与 WebSocket HMR", () => {
    expect(devConnectSrc).toContain("ws://localhost:1420");
    expect(devConnectSrc).toContain("ws://localhost:1421");
  });

  it("生产与开发策略等于设计文档中的完整指令表", () => {
    expect(csp).toEqual({
      "default-src": "'self' customprotocol: asset:",
      "script-src": "'self'",
      "style-src": "'unsafe-inline' 'self'",
      "img-src":
        "'self' asset: http://asset.localhost https://asset.localhost blob: data:",
      "connect-src": "ipc: http://ipc.localhost https://ipc.localhost",
      "font-src": "'self' data:",
      "object-src": "'none'",
      "base-uri": "'self'",
      "form-action": "'self'",
      "frame-src": "'none'",
    });
    expect(devCsp).toEqual({
      "default-src": "'self' customprotocol: asset: http://localhost:1420",
      "script-src": "'self' 'unsafe-inline' 'unsafe-eval' http://localhost:1420",
      "style-src": "'unsafe-inline' 'self' http://localhost:1420",
      "img-src":
        "'self' asset: http://asset.localhost https://asset.localhost blob: data: http://localhost:1420",
      "connect-src":
        "ipc: http://ipc.localhost https://ipc.localhost http://localhost:1420 ws://localhost:1420 ws://localhost:1421",
      "font-src": "'self' data: http://localhost:1420",
      "object-src": "'none'",
      "base-uri": "'self'",
      "form-action": "'self'",
      "frame-src": "'none'",
    });
  });
});
