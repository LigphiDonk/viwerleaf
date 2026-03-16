# ViewerLeaf

<p align="center">
  <img src="./icons/icon.png" alt="ViewerLeaf logo" width="160" height="160" />
</p>

English | [中文](#中文)

## English

ViewerLeaf is a macOS-first desktop workbench for academic writing with LaTeX, PDF preview, SyncTeX navigation, and local-first agent workflows.

### Features

- Project tree for LaTeX workspaces
- CodeMirror editor for source files
- PDF preview powered by `pdf.js`
- Compile log and diagnostics dock
- Agent profile workflow for writing tasks
- Figure workspace for asset generation and insertion
- Tauri + Rust desktop backend for project, compile, and sync commands

### Prerequisites

- Node.js 20+
- Rust toolchain with Cargo
- `latexmk`
- `synctex`

### Local Development

```bash
npm install
npm run tauri dev
```

If you only want the frontend shell in a browser:

```bash
npm install
npm run dev
```

### Build

```bash
npm run tauri build
```

### macOS Install Note

GitHub Actions builds are currently unsigned and not notarized. On macOS, downloading the app from GitHub may trigger a warning such as "is damaged" or prevent the app from opening.

To remove the quarantine flag locally:

```bash
xattr -dr com.apple.quarantine /Applications/ViewerLeaf.app
```

If you are opening a downloaded DMG first, you can also remove quarantine from the DMG:

```bash
xattr -dr com.apple.quarantine /path/to/ViewerLeaf_0.1.0_aarch64.dmg
```

You may also need to open the app once from `System Settings -> Privacy & Security`.

### Notes

- The browser runtime uses a mock backend so the UI can be exercised without Tauri.
- The packaged desktop app expects a local LaTeX toolchain for compile and SyncTeX features.
- Worker quick deploy in the desktop app exports a bundled Worker template into the app data directory first, so end users do not need a local `./workers` repo folder. They still need Node.js and a Cloudflare account logged in via Wrangler.
- Unsigned macOS builds are suitable for personal/testing distribution, not polished end-user release distribution.

### License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).

## 中文

ViewerLeaf 是一个面向 macOS 的本地优先学术写作工作台，集成了 LaTeX 编辑、PDF 预览、SyncTeX 跳转和 AI 工作流。

### 功能

- LaTeX 项目文件树
- 基于 CodeMirror 的源码编辑器
- 基于 `pdf.js` 的 PDF 预览
- 编译日志与诊断面板
- 面向写作任务的 Agent 配置流程
- 图片生成与插入工作区
- 基于 Tauri + Rust 的桌面端项目、编译与同步能力

### 环境要求

- Node.js 20+
- Rust toolchain 与 Cargo
- `latexmk`
- `synctex`

### 本地开发

```bash
npm install
npm run tauri dev
```

如果你只想在浏览器里启动前端界面：

```bash
npm install
npm run dev
```

### 构建

```bash
npm run tauri build
```

### macOS 安装说明

当前 GitHub Actions 构建产物还没有做 Apple 签名和公证。在 macOS 上直接从 GitHub 下载时，系统可能提示“已损坏”或阻止应用打开。

可以在本地移除 quarantine 标记：

```bash
xattr -dr com.apple.quarantine /Applications/ViewerLeaf.app
```

如果你是先下载 `.dmg` 再安装，也可以先对 DMG 执行：

```bash
xattr -dr com.apple.quarantine /path/to/ViewerLeaf_0.1.0_aarch64.dmg
```

必要时还可以到“系统设置 -> 隐私与安全性”中手动允许打开一次。

### 说明

- 浏览器运行模式使用 mock backend，因此不依赖 Tauri 也可以体验界面。
- 打包后的桌面应用依赖本地 LaTeX 工具链来完成编译与 SyncTeX 功能。
- 桌面版里的 Worker 快捷部署会先把内置 Worker 模板释放到应用数据目录，所以最终用户不需要项目仓库里的 `./workers` 文件夹；但仍然需要本机有 Node.js，并且已通过 Wrangler 登录 Cloudflare。
- 未签名的 macOS 构建更适合个人测试分发，不适合作为正式面向普通用户的安装包。

### 许可证

本项目采用 MIT 许可证，见 [LICENSE](./LICENSE)。
