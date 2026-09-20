# CSP 防护设计

## 背景

SSHX 是 Tauri 2 桌面应用，前端为 Vite + React。当前 `src-tauri/tauri.conf.json` 中 `app.security.csp` 为 `null`，`index.html` 也没有 CSP meta。WebView 可以加载任意脚本来源，XSS 一旦发生即可调用 `invoke`。壁纸预览通过 `convertFileSrc` 走 `asset:` / `asset.localhost`；界面与 xterm 使用 React 内联 `style`。

## 目标

- 生产 WebView 强制 CSP，禁止远程脚本、`eval` 和内联脚本。
- 开发使用独立 `devCsp`，保证 `tauri dev` 下 Vite HMR 可用。
- 不破坏壁纸 `convertFileSrc`、Tauri IPC、xterm / Radix 内联样式。
- 用单测锁定策略内容，防止再次被设回 `null` 或放宽生产脚本源。

## 方案

只改 `src-tauri/tauri.conf.json` 的 `app.security`，使用 Tauri 对象格式的 `csp` 与 `devCsp`。不修改 `index.html`，不增加 CSP meta，不抽出策略生成模块。

Tauri 在编译期会给本地脚本追加 hash、给样式追加 nonce，并在需要时补上 `ipc:` / `asset:` 相关源。配置里仍写全应用必需的源，不依赖隐式补全作为唯一保障。

`assetProtocol` 保持 `enable: true`、`scope: ["**"]`。`devCsp` 是开发期完整策略，不是在 `csp` 上做增量合并。

## 生产策略（`csp`）

```json
{
  "default-src": "'self' customprotocol: asset:",
  "script-src": "'self'",
  "style-src": "'unsafe-inline' 'self'",
  "img-src": "'self' asset: http://asset.localhost https://asset.localhost blob: data:",
  "connect-src": "ipc: http://ipc.localhost https://ipc.localhost",
  "font-src": "'self' data:",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
  "frame-src": "'none'"
}
```

约束：

- `script-src` 不含 `'unsafe-eval'`、`'unsafe-inline'`，也不含任意 `https:` / `http:` 远程源。
- `style-src` 保留 `'unsafe-inline'`，覆盖 React、Radix 与 xterm 的内联样式。
- `img-src` 覆盖 macOS/Linux 的 `asset:` 与 Windows WebView2 的 `asset.localhost`。
- `connect-src` 只服务 Tauri IPC，不含普通 `https:`。

## 开发策略（`devCsp`）

完整写出，包含生产全部指令，并仅为 Vite 增加本机开发源：

```json
{
  "default-src": "'self' customprotocol: asset: http://localhost:1420",
  "script-src": "'self' 'unsafe-inline' 'unsafe-eval' http://localhost:1420",
  "style-src": "'unsafe-inline' 'self' http://localhost:1420",
  "img-src": "'self' asset: http://asset.localhost https://asset.localhost blob: data: http://localhost:1420",
  "connect-src": "ipc: http://ipc.localhost https://ipc.localhost http://localhost:1420 ws://localhost:1420 ws://localhost:1421",
  "font-src": "'self' data: http://localhost:1420",
  "object-src": "'none'",
  "base-uri": "'self'",
  "form-action": "'self'",
  "frame-src": "'none'"
}
```

`ws://localhost:1421` 对应 `vite.config.ts` 在设置 `TAURI_DEV_HOST` 时的 HMR 端口。未设置该变量时，HMR 走 `ws://localhost:1420`。不额外放行局域网 IP；需要远程调试时再单独放宽 `devCsp`。

## 组件与数据流

本功能不新增运行时组件或 IPC。WebView 在加载 HTML 时由 Tauri 注入 `Content-Security-Policy`。前端继续用现有 `invoke`、`convertFileSrc` 与 xterm；策略只限制浏览器允许加载的来源，不改变会话、文件传输或设置的数据流。

## 边界与异常处理

- 开启 CSP 后若某功能被拦，优先检查是否漏了已知源（壁纸 `asset:`、IPC、开发 HMR），而不是把生产 `script-src` 放宽为 `'unsafe-eval'`。
- 生产构建不应依赖 Vite 开发服务器地址。
- xterm WebGL 在主线程渲染，不为 WASM 增加 `'wasm-unsafe-eval'`。
- 设置页指向 GitHub 的普通链接不需要 `connect-src`；若将来用 `fetch` 拉远程资源，再单独加源。

## 测试

新增 Vitest（`src/lib/tauriCsp.test.ts`），读取 `src-tauri/tauri.conf.json`：

1. `app.security.csp` 与 `app.security.devCsp` 均为对象且不为 `null`。
2. 生产 `script-src` 含 `'self'`，不含 `'unsafe-eval'`、`'unsafe-inline'`，也不含 `https:` / `http:`。
3. 生产 `style-src` 含 `'unsafe-inline'` 与 `'self'`。
4. 生产 `img-src` 含 `asset:`、`http://asset.localhost`、`https://asset.localhost`。
5. 生产 `connect-src` 含 `ipc:` 与 `http://ipc.localhost`。
6. 生产 `object-src` 为 `'none'`，`frame-src` 为 `'none'`。
7. `devCsp.script-src` 含 `'unsafe-eval'` 与 `http://localhost:1420`。
8. `devCsp.connect-src` 含 `ws://localhost:1420` 与 `ws://localhost:1421`。
9. 现有前端测试与 `pnpm build` 保持通过。

测试在写入配置前按预期失败，写入后通过。

## 范围外

- 收紧 `assetProtocol.scope`
- `freezePrototype`、HTML meta CSP、CSP `report-uri`
- 去掉 `style-src` 的 `'unsafe-inline'`（nonce 化 React / xterm 样式）
- 为 `TAURI_DEV_HOST` 局域网地址放行
