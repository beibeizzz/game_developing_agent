# game_developing_agent MCP

game_developing_agent 的 stdio 工具服务与本地 CLI。Python 3.11+，依赖由 `uv.lock` 固定。

从仓库根目录运行 `bash scripts/setup.sh`，再运行 `bash game_developing_agent --help`。完整安装、账户配置和恢复步骤见根目录 README。

直接启动服务：`bash scripts/run.sh game_developing_agent-mcp`。工具 schema 由 `src/game_developing_agent_mcp/tools/` 注册，生产状态与浏览器验收经 MCP 执行。

`validate_asset_video` 通过 Claude Code Seed 2.1 Pro 观察本地采样帧，保存 JSON 判定、原始帧、时间戳和覆盖范围；浏览器检查负责确认动画实际播放。

许可证与第三方声明见根目录 LICENSE、NOTICE。
