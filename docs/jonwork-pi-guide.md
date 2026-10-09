# jonwork-pi 架构与使用手册

## 项目定位

`jonwork-pi` 是 Jonwork 维护的 Pi 源码仓库。仓库名和根工作区名使用 `jonwork-pi`；为了兼容已有用户、配置和 npm 包，命令名 `pi`、配置目录 `.pi` 以及 `@earendil-works/pi-*` 包名保持不变。

运行环境要求：

- Node.js 22.19 或更高版本
- npm
- 至少一个已配置的模型提供方登录或 API 密钥

## 架构组件

```mermaid
flowchart LR
    subgraph client ["用户入口"]
        terminal[终端]
        sdkApp[SDK 应用]
        remoteClient[远程客户端]
    end
    subgraph gateway ["交互层"]
        codingAgent[pi CLI]
        clientPkg[Client 包]
    end
    subgraph service ["核心服务"]
        agentCore[Agent Core]
        aiLayer[AI 提供方抽象]
        toolLayer[内置工具与扩展]
        mcpClient[MCP Client]
        durable[Durable Session]
        server[本地 Server]
        protocol[Protocol]
        chord[Chord Runtime]
        telemetry[Telemetry]
        tui[TUI]
    end
    subgraph datastore ["本地数据"]
        config[.pi 配置]
        sessions[会话与任务数据]
    end
    subgraph external ["外部集成"]
        modelApi[模型提供方]
        mcpServer[MCP Server]
    end

    terminal -->|"交互输入"| codingAgent
    sdkApp -->|"调用 API"| clientPkg
    remoteClient -->|"远程会话"| clientPkg
    codingAgent -->|"渲染"| tui
    codingAgent -->|"驱动循环"| agentCore
    clientPkg -->|"发送协议帧"| protocol
    protocol -->|"路由请求"| server
    server -->|"托管会话"| durable
    durable -->|"编排能力"| chord
    agentCore -->|"流式推理"| aiLayer
    agentCore -->|"执行"| toolLayer
    toolLayer -->|"调用工具"| mcpClient
    codingAgent -->|"读取"| config
    durable -->|"读写"| sessions
    agentCore -->|"记录事件"| telemetry
    aiLayer -.->|"AI: 请求与流式响应"| modelApi
    mcpClient -.->|"MCP: 工具调用"| mcpServer
```

主要组件职责：

| 组件 | 目录 | 职责 |
|---|---|---|
| Coding Agent | `packages/coding-agent` | `pi` 命令、交互循环、工具、扩展、会话管理 |
| Agent Core | `packages/agent` | 消息状态、模型调用、工具调用与事件流 |
| AI | `packages/ai` | 多模型提供方、鉴权、流式响应、用量统计 |
| TUI | `packages/tui` | 终端渲染与输入组件 |
| MCP | `packages/mcp` | stdio/HTTP MCP 客户端与 OAuth |
| Durable | `packages/durable` | 持久会话、任务和文档运行时 |
| Protocol / Client / Server | `packages/protocol`、`packages/client`、`packages/server` | CBOR 协议、远程客户端和本地会话路由 |
| Chord | `packages/chord` | 服务组合、复制状态、RPC 与插件运行时 |
| Telemetry | `packages/telemetry` | 厂商无关的遥测契约和类型 |

## 启动流程

```mermaid
flowchart TD
    start([开始]) --> checkNode{Node.js 版本不低于 22.19?}
    checkNode -- 否 --> installNode[安装或升级 Node.js]
    installNode --> installDeps
    checkNode -- 是 --> installDeps[执行 npm install --ignore-scripts]
    installDeps --> runSource[执行 ./pi-test.sh]
    runSource --> loadConfig[加载配置、扩展、技能和主题]
    loadConfig --> hasAuth{模型提供方已登录?}
    hasAuth -- 否 --> login[在 pi 中执行 /login]
    login --> selectModel
    hasAuth -- 是 --> selectModel[选择模型并创建或恢复会话]
    selectModel --> ready([进入交互界面])
    ready --> prompt[/输入任务/]
    prompt --> agentLoop[Agent 调用模型]
    agentLoop --> needsTool{需要调用工具?}
    needsTool -- 是 --> runTool[执行工具或 MCP 调用]
    runTool --> agentLoop
    needsTool -- 否 --> render[流式渲染结果]
    render --> ready
```

## 首次安装与启动

在仓库根目录执行：

```bash
node --version
npm install --ignore-scripts
./pi-test.sh
```

`./pi-test.sh` 直接从当前源码启动 CLI，适合开发和验收。首次进入后执行 `/login`，选择模型提供方并完成登录，然后输入任务即可。

如需使用已发布版本：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi
```

## 常用操作

| 目标 | 命令 |
|---|---|
| 从源码启动 | `./pi-test.sh` |
| 检查代码 | `npm run check` |
| 运行非端到端测试 | `./test.sh` |
| 离线构建 | `npm run build:offline` |
| 查看 CLI 参数 | `./pi-test.sh --help` |
| 在交互界面登录 | `/login` |
| 退出交互界面 | `/exit` 或 `Ctrl+C` |

## 配置与扩展

Pi 从用户配置目录和项目内的 `.pi` 目录加载配置。常用扩展点：

- 扩展：`packages/coding-agent/docs/extensions.md`
- 技能：`packages/coding-agent/docs/skills.md`
- 提示词模板：`packages/coding-agent/docs/prompt-templates.md`
- 主题：`packages/coding-agent/docs/themes.md`
- CLI 自动化：`packages/coding-agent/docs/cli.md`
- RPC 控制：`packages/coding-agent/docs/rpc.md`
- TypeScript SDK：`packages/coding-agent/docs/sdk.md`

配置和凭据不要提交到 Git。使用项目级配置前，先检查其权限范围和工具命令。

## 停止与重新启动

前台运行时，先在交互界面执行 `/exit`，或按 `Ctrl+C` 停止，再重新运行：

```bash
./pi-test.sh
```

如果 Pi 由终端复用器或进程管理器托管，应在原托管会话中停止旧进程并启动新进程，避免产生多个会话同时写入同一状态目录。

## 验证与故障排查

1. `node --version` 应满足最低版本要求。
2. `npm install --ignore-scripts` 应正常完成，且不执行依赖生命周期脚本。
3. `./pi-test.sh --help` 应输出 CLI 帮助。
4. 交互启动后应能完成 `/login`、选择模型、发送消息和退出。
5. 若启动失败，先检查终端错误、Node.js 版本、依赖安装状态和模型凭据。
6. 若工具不可用，检查扩展配置、MCP 服务器命令和进程权限。

项目默认直接继承当前用户的文件系统、进程、网络和凭据权限。需要更强隔离时，参考 `packages/coding-agent/docs/containerization.md` 使用容器或沙箱。

## 更新与回滚

更新前记录当前提交：

```bash
git rev-parse HEAD
```

更新后执行 `npm run check` 和必要的专项测试，再重启 CLI。若新提交导致问题，保留工作区变更，切换回已验证提交或通过新的回滚提交恢复；不要对共享工作区使用破坏性的重置命令。
