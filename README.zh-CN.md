# SessionMaster

[English](README.md) | **简体中文**

**一个用于统一管理所有 AI Coding 会话的 Local-first Web 工作台。**

SessionMaster 将 Codex 和 Claude Code 汇集到一个简洁、可搜索的界面中，同时不会替代任何原生 CLI。它可以发现原生会话历史，以结构化形式展示对话和工具活动，并支持从浏览器中新建、恢复、接续或停止托管会话。

所有功能都在本地运行。原生历史始终是事实来源，服务默认只监听 `127.0.0.1`，无需依赖任何 SessionMaster 云端服务。

![SessionMaster 统一会话工作台](docs/assets/sessionmaster-ui.jpg)

> 截图使用隔离的演示数据生成，仓库中不包含任何本地真实会话内容。

## 为什么需要 SessionMaster

AI Coding 工具很擅长在单个项目中工作，但随着使用时间增加，会话很容易散落在多个终端窗口、历史文件和不同 CLI 中。SessionMaster 补齐了这层统一协调能力：

- 在一个收件箱中查看多个 Coding Agent 的会话；
- 清楚区分运行中、等待中、已完成和失败状态；
- 跨项目和对话内容搜索历史；
- 结构化展示消息、命令、工具调用和权限请求；
- 明确执行跨 Agent 上下文接力，不会伪装成原生恢复。

SessionMaster 不是新的 Coding Agent、IDE，也不是一个隐藏会话所属后端的代理层。

## 功能特性

### 统一的本地会话收件箱

- 自动发现 Codex 和 Claude Code 的原生历史，且不会修改历史文件。
- 将会话分为 **需要处理**、**运行中** 和 **最近会话**。
- 支持按后端筛选，并搜索标题、项目、路径和消息历史。
- 每条会话都显示具体日期和所属 Agent。
- 支持手动刷新原生历史，并提供明确的刷新进度和完成反馈。

### 结构化对话视图

- 将用户和 Assistant 消息渲染为清晰易读的对话块。
- 支持在 Markdown 渲染与消息原文之间切换。
- 在不注入不可信 HTML 的前提下渲染常用 Markdown 格式和本地图片；本地图片仅允许来自会话工作目录或临时目录。
- 展示命令、终端输出、推理过程、工具调用、工具结果和错误。
- 长 JSON、日志和命令输出会被限制在对话区域内，不会撑破布局。
- 通过 WebSocket 将托管运行时的事件实时推送到界面，并将增量文本和终端输出合并为易读内容。

### 界面偏好

- 可直接在侧边栏切换中性风与浅蓝灰主题。
- 在本地浏览器中记住主题和消息渲染方式。
- 所有偏好都保存在本地，不依赖账号或云端设置服务。

### 托管运行时控制

- 在已有本地项目目录中启动新的 Codex 或 Claude Code 会话。
- 通过各后端支持的原生协议恢复历史会话。
- 向由 SessionMaster 启动或恢复的运行时发送后续消息。
- 展示权限请求，并提供明确的允许和拒绝操作。
- 仅在确认后端进程已经退出后才将会话显示为已停止。系统会先尝试优雅终止，必要时升级为强制终止；如果无法确认进程退出，则会保留运行状态。

### 跨 Agent 接续

使用 **Continue with** 可以在另一个后端中创建新会话。SessionMaster 会根据最近的对话构建有限的上下文交接内容，并记录原会话与接续会话之间的关系。新会话会被明确标记为接续，而不是伪装成原生恢复。

## 支持的后端

| 能力 | Codex | Claude Code |
|---|---:|---:|
| 可执行文件检测 | ✓ | ✓ |
| 原生历史发现 | ✓ | ✓ |
| 结构化历史 | ✓ | ✓ |
| 启动托管会话 | ✓ app-server | ✓ stream-json |
| 原生会话恢复 | ✓ app-server | ✓ `--resume` |
| 实时结构化事件 | ✓ | ✓ |
| 发送后续消息 | ✓ | ✓ |
| 权限允许/拒绝 | ✓ | ✓ |
| 确认进程退出后停止 | ✓ | ✓ |
| 跨 Agent 上下文接力 | ✓ | ✓ |
| 接入任意现有终端 | — | — |

系统会在启动时检测各项能力。单个适配器损坏或不可用，不会阻止另一个后端正常工作。

当前版本暂不包含 ZCode 支持。

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 10+
- 本地已安装并完成认证的 Codex 和/或 Claude Code

SessionMaster 会优先检测 macOS ChatGPT 应用内置的 Codex 二进制文件，然后检查常见 CLI 路径。Claude Code 会从常见的 Homebrew 和本地安装路径中检测。

## 快速开始

```bash
git clone https://github.com/hkcao/SessionMaster.git
cd SessionMaster
pnpm install
pnpm build
pnpm start
```

打开 [http://127.0.0.1:4310](http://127.0.0.1:4310)。

开发模式：

```bash
pnpm dev
```

Vite 前端运行在 `http://127.0.0.1:4311`，并将 API 和 WebSocket 请求代理到 4310 端口上的本地服务。

## 架构

SessionMaster 是一个使用 TypeScript 和 pnpm 构建的 monorepo：

```text
apps/
  server/          Fastify REST/WebSocket API 和本地 SQLite 索引
  web/             React 和 Vite 用户界面
packages/
  core/            共享的会话、运行时、事件和适配器协议
  adapter-codex/   Codex 历史与 app-server 集成
  adapter-claude/  Claude Code 历史与 stream-json 集成
```

核心注册表会隔离各后端故障，并提供统一的能力模型。适配器将原生历史和实时协议事件标准化为公共事件流，同时保留后端身份和原生会话 ID。

领域模型和协议流程请参阅 [docs/architecture.md](docs/architecture.md)。

## 本地数据与安全

- 原生历史仍然保存在 `~/.codex` 和 `~/.claude` 下。
- SessionMaster 将本地索引和会话接续关系存储在 `.session-master/session-master.sqlite` 中。
- 服务默认只监听 localhost。
- 权限请求永远不会被自动批准。
- 不会索引认证文件、环境变量、API Key 或 Token。
- 只有属于当前会话工作目录或系统临时目录的本地对话图片才会由服务读取。
- 只有通过 SessionMaster 启动或恢复的运行时才能被控制，不会接管任意现有终端进程。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
```

测试覆盖核心注册表行为、适配器事件标准化、会话发现与筛选、恢复后运行状态保持、确认停止后的状态清理、HTTP 路径与文件读取边界、实时事件合并，以及不安全 Markdown 链接处理。

## 当前限制

- 当前界面主要面向桌面尺寸的本地浏览器。
- 不支持接入任意现有 PTY 或终端窗口。
- 只有通过 SessionMaster 启动或恢复的会话支持运行时控制。
- 暂未实现 ZCode 支持。
