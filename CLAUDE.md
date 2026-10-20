<!-- Modified for game_developing_agent, 2026: local development workflow and runtime integration. -->
# GAME_DEVELOPING_AGENT Repository Instructions

## Scope

This repository contains the game-creation pipeline, the `game_developing_agent` MCP server,
shared contracts, and generated Phaser 4 games under `playground/<game-slug>/`.
During a pipeline, `<GAME_DIR>` is the absolute root of one active game project,
typically `<REPO_ROOT>/playground/<game-slug>/`. MCP `game_dir` arguments and
dispatch `GAME_DIR` fields refer to the same path.
Apply the routed scoped instructions plus these global rules; keep this file free
of duplicated tool counts, thresholds, matrices, and config defaults.

## Global Invariants

- During a game pipeline, use `game_developing_agent` MCP tools for asset generation,
  post-processing, browser/game verification, video analysis, and gates. Never
  invoke bundled runners, Playwright, or gates directly. Shell commands are
  limited to orchestration required by the pipeline skill; repository development
  may run lint, compile checks, focused diagnostics, and tests.
- **MUST NOT fabricate** assets, state transitions, counters, evidence,
  screenshots, or verdicts. Defaults and thresholds live in `game_developing_agent.config.yaml`;
  hooks, MCP handlers, and composite gates enforce them.
- **MUST NOT hot-restart or close** the MCP server mid-pipeline. On disconnect,
  pause for user reconnection and resume from persisted evidence.
- Final assets require declared provenance and usage rights, manifest integration,
  and runtime/visual fitness.

## Sources of Truth

- `GAME_DESIGN.md` owns authored design and mechanics; during the automated
  pipeline, only design-agent writes it. Only `level_model: authored` uses
  `levels/*.json`.
- `quality_profile` controls art, UI sizing, and VFX policy.
  `assets/asset-manifest.json` owns runtime keys, final paths, shipped dimensions,
  and metadata sidecars.
- Workers write only owned artifacts and sidecars; shared authorities follow the
  single-writer contracts. Crop-seeded stills use
  `produce_static_asset({ref_image: ..., asset_type: <canonical category>})`;
  every UI/lettering/widget uses `asset_type:"ui"`. Layout evidence uses
  `materialize_layout_alignment`.
- `game_developing_agent.config.yaml` owns runtime defaults. `<GAME_DIR>/.playtest/` owns pipeline
  progress and evidence.

## Task Routing

- New game creation or pipeline resume: `.claude/skills/game-pipeline/SKILL.md`.
- Agent contracts: `.claude/skills/game-pipeline/dispatch-contract.md`,
  `.claude/agents/*.md`, and `.claude/rules/*.md`.
- Design contracts: the game-pipeline skill's `references/design/gdd-template.md`
  and `references/quality-profiles.md`.
- Scoped implementation: `game_developing_agent-mcp/CLAUDE.md` for MCP; `playground/CLAUDE.md` for
  generated games.

## Game-Pipeline Recovery

For interrupted game pipelines only, follow
`.claude/skills/game-pipeline/SKILL.md` → "10. Resume After Interruption".
Select one bound `<GAME_DIR>` (ask if multiple `playground/<game-slug>/`
candidates exist); validate state/resume/audit breadcrumbs against
current artifacts and in-flight work, then continue from the first incomplete
phase. Stop on authentication, quota, permission, or user-decision blockers.


# game_developing_agent 开发工作流

CLI 入口 `game_developing_agent`，Python 模块 `game_developing_agent_mcp.local.cli`；stdio MCP 入口 `game_developing_agent-mcp`。运行策略集中在 `game_developing_agent.config.yaml`，角色与生产合同位于 `.claude/`。

## 生产合同

1. 主控按 game-pipeline skill 分派专业角色，角色串行交接；`GAME_DESIGN.md` 由 design-agent 写入，游戏代码同时只有一个 writer。
2. 使用 `game_developing_agent-mcp/src/game_developing_agent_mcp/local/templates/dodge` 的 Phaser 4 游戏合同与 TypeScript 确定性关卡生成器。游戏消费 `game-spec.json` 和 `levels/stage_N.json` 的相同波次数据。
3. 每次修改更新受影响的 spec/game/asset/level revisions。MCP 负责资产操作、浏览器验证与状态写入，证据绑定当前源码 digest 和 pipeline_run_id。
4. 图片和动画调用记录模型、任务 ID 与返回用量，已提交任务按 ID 恢复，未知提交保留检查点。媒体范围由当前用户请求决定。
5. `verify_development` 执行构建、九组关卡、浏览器脚本和可选的独立视觉检查。主 Claude 退出后由外层 CLI 调度 Seed 视觉进程。
6. 制作完成后写入实际 next_action。通过 `resume --verify-only --vision` 可直接交接外层验证，成功后恢复记录自动更新。源码和构建包由 `build` 生成。

## 状态与用量

游戏 `.playtest/state.json`、`resume.json`、`verify/verify-report.json` 保存权威状态；`history/claude-session.json` 保存模型恢复信息。`resume` 仅复用身份、digest 和验收证据均匹配的完成结果。

`.playtest/telemetry/` 保存分版本试玩事件，复盘结果保存在 `reviews/` 与 `proposals/`。候选经验保存在 `.game_developing_agent/memory/`，显式激活后参与检索。

通用用量保存在 `.game_developing_agent/usage.json`，包含任务状态、模型、请求次数、返回的 token 用量和媒体任务 ID。通过 `usage` 命令查看记录。

运行器离线证据与可选请求上限保存在仓库 `.game_developing_agent/`。每次管线有独立 HTTP 请求计数，所有子任务共享；运行器证据由 `bash scripts/verify-runtime.sh` 生成。

Seedance 提交和轮询分别保存检查点；已有任务按 ID 恢复，任务成功后保留服务端返回用量与完成状态。未知提交保持原记录，避免重复提交。

## 示例合同

模板支持 WASD/方向键移动、暂停、重开、三种难度和固定 seed。遥测 schema v2 使用 `cause`、`hp` 和逐局递增 `obstacle_id`，持续免疫碰撞去重。`local_fixture` 标记模板生成来源。development 验收与完整发行验收分别保存。
