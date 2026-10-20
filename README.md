# game_developing_agent

game_developing_agent 是用于创建和迭代 Phaser 浏览器游戏的本地命令行工具。自然语言任务通过 Claude Code 分派给专业角色，stdio MCP 执行素材处理、构建和验证。项目保存检查点、试玩记录、迭代提案及可显式激活的经验。

当前版本：**0.1.0rc1**。支持 Linux 与 Windows WSL2；游戏通过本地 HTTP 服务运行。

## 安装

准备 Node.js 22.12+、uv、Git、curl、ffmpeg/ffprobe、openssl，以及 Chromium 所需系统库和中文字体。宿主检查配置见 [preflight-requirements.toml](scripts/preflight-requirements.toml)。离线运行器探针使用 Linux 用户/网络命名空间，需要可用的 `unshare`。

将源码解压到 Linux 文件系统目录（例如 `~/projects/game_developing_agent`），然后在该目录的 WSL/Linux 终端执行：

```bash
bash scripts/setup.sh
bash game_developing_agent --help
bash scripts/verify-runtime.sh
```

Python 3.11 环境安装在 `game_developing_agent-mcp/.venv`，Claude Code 2.1.303 和 Playwright 1.64.1 安装在 `.tools`。`uv.lock` 固定 Python 依赖；游戏模板附带 npm 锁文件。安装需要联网下载依赖。`verify-runtime.sh` 通过本机模拟响应检查流式、回退、子任务计数和视觉路由，云 API 调用为零。

依赖目录可分别通过 `GAME_DEVELOPING_AGENT_LOCAL_TOOLS_DIR` 和 `GAME_DEVELOPING_AGENT_PYTHON_ENV` 设置。安装器和运行器应使用相同设置。Windows 命令入口：`scripts/game_developing_agent.ps1`，默认 WSL 发行版为 Ubuntu。

## 本地示例

```bash
GAME="$(pwd)/playground/demo"
bash game_developing_agent create --project "$GAME" --local-fixture '制作陨石躲避游戏'
bash game_developing_agent preview --project "$GAME" --port 8080
# 在另一个终端运行：
bash game_developing_agent build --project "$GAME"
bash game_developing_agent verify --project "$GAME" --profile development
```

示例由代码绘制资源，使用可复现的波次与 seed。运行时生成游戏源码和构建包，位置为游戏目录的 `delivery/`。`--local-fixture` 表示模板运行；云生成来源单独记录。本地验证会检查构建、九组关卡与浏览器行为；完整 development 验收还需 `--vision` 的真实视觉结果。

## 云任务配置

1. 将 `.env.example` 复制为 `.env`，填写 `ARK_AGENT_PLAN_API_KEY`。
2. 执行 `bash game_developing_agent doctor --project "$(pwd)"` 检查凭据、工具和运行器。

| 用途 | 模型 |
| --- | --- |
| 主控与开发角色 | `deepseek-v4.1-flash` |
| 图片 | `doubao-seedream-5.0-pro` |
| 动画 | `doubao-seedance-2.0-fast` |
| 独立视觉验证 | `doubao-seed-2.1-pro` |

四个模型共用方舟 Agent Plan 密钥，具体模型按任务类型路由。

```bash
GAME="$(pwd)/playground/my-game"
bash game_developing_agent create --project "$GAME" '制作俯视角陨石躲避游戏'
bash game_developing_agent change --project "$GAME" '增大生命数字并降低普通难度速度'
bash game_developing_agent resume --project "$GAME" --inspect
bash game_developing_agent resume --project "$GAME"
# 制作已完成时，直接交接外层验证：
bash game_developing_agent resume --project "$GAME" --verify-only --vision
bash game_developing_agent review --project "$GAME"
```

## 请求计数与恢复

每次管线启动记录实际文本 HTTP 请求，主控、子任务及自动回退共用计数。通用用量记录包含模型、请求次数、返回的 token 用量和媒体任务 ID，使用 `bash game_developing_agent usage --project "$(pwd)"` 查看。请求上限由运行器配置的可选 `maximum_requests` 设置；默认持续记录请求。

达到本地请求上限时，返回 `http_request_limit`，保存原请求、会话和下一步命令。`resume` 续跑当前会话并创建本次运行记录。`resume --verify-only` 直接执行真实验证；验证成功会同步恢复记录。已完成且证据仍匹配当前源码的项目通过本地结果返回。

## 当前边界

- 一个活动游戏、一个代码 writer；开发角色串行交接。支持本地试玩与离线复盘。
- 游戏浏览器预览已提供；用于提交自然语言任务、查看进度、用量和提案的 Web 管理界面处于后续开发范围。
- `development_ready` 表示开发验收结果；完整发行门禁由 `ready_to_ship` 表示。状态按实际证据保存。
- Seedance 保存提交检查点与任务 ID，已受理任务按原 ID 恢复；提交结果未知时保留现场供检查。
- 动画视觉检查保存原始抽帧、时间戳、哈希及 JSON 观察报告；结论范围为已观察的采样帧，运行时播放由浏览器检查。

## 开发与打包

```bash
bash scripts/setup.sh --dev
bash scripts/check.sh
python3 scripts/package.py --output dist
```

发布源码 ZIP 由当前 Git 跟踪文件生成，旁边附 SHA-256 校验文件。运行数据、凭据、依赖目录和媒体文件保存在本地。Python wheel 是 MCP 组件，完整命令工作流请使用源码发行包。

许可证：Apache-2.0；第三方组件声明及改动归属见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
