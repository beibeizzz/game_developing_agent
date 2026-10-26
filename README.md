# game_developing_agent

本地游戏开发工作台。通过专业 Agent 协作，将创意推进到方案审核、素材制作、代码生成、游戏试玩和迭代测评。

TypeScript、LangGraph、SQLite、React/Vite 和本地 Docker。支持多个项目，每次执行一个项目任务；首版游戏为单机离线浏览器躲避游戏。

## 功能

- 生产流程：玩法调研、策划、美术、音频、游戏编码、关卡设计与编码、构建交付。
- 经典视图与画布共用版本和审核状态；任务支持取消、检查点续跑与执行记录查看。
- 运营流程：专家独立分析、讨论、改进提案、新游戏立项、实验预登记、后测与结算。
- 人工试玩与脚本测评分开记录；知识条目经审核后参与后续任务。
- 设计与运营角色使用方舟接口；两个编码角色通过 Claude Agent SDK 在本地容器执行。

## 安装与启动

环境：Node.js 22.22+、npm、Docker（Linux 容器）。请确保当前账户具备所选模型的调用权限。

```powershell
npm ci
Copy-Item .env.example .env
```

首次安装后在 `.env` 填入 `ARK_AGENT_PLAN_API_KEY`。已有配置可直接沿用，模型名与执行参数通过环境变量调整。

```powershell
npx playwright install chromium
npm run build
npm run coder:build
npm start
```

工作台：http://127.0.0.1:8787 。游戏预览默认使用独立端口 8788。

Windows 后台启动与停止：

```powershell
./scripts/start-workbench.ps1
./scripts/stop-workbench.ps1
```

## 使用

1. 新建项目，写明玩法、操作、难度和验收目标，启动“创意制作”。
2. 依次检查调研参考、策划、美术和关卡方案；批准或填写修改意见。
3. 在“游戏试玩”运行脚本测评并实际游玩，保存体验反馈，核对交付结果。
4. “修改游戏”用于直接提出修改；“运营与实验”用于分析证据、审核提案、执行预登记实验并结算。
5. “制作新游戏”分区用于形成候选立项方案，批准后创建独立项目；“记忆与知识”管理可复用经验。

失败任务保留产物和阶段。查看错误详情后使用“继续任务”；模型结构化输出连续失败等情况可能需要调整提示或人工处理。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:browser
npm run package:source
```

浏览器回归使用隔离合成数据，端口为 18807/18808。运行测试无需模型密钥。真实模型效果、游戏体验与恢复能力通过各项目实际任务验证。

源码包输出到 `dist/releases/`，包含开发源码和已构建工作台。项目状态、生成游戏、会话与日志存入 `.local/`，凭据保存在 `.env`。这些本机内容由 Git 和源码打包排除。备份项目时保存完整本地数据目录，凭据独立保管。

| 路径 | 用途 |
| --- | --- |
| `src/production.ts`、`src/operations.ts` | 生产与运营流程 |
| `src/coder*.ts` | 编码容器、SDK 会话和执行恢复 |
| `src/evaluation.ts`、`src/browser-evaluation.ts` | 测评、实验预登记和结算 |
| `src/memory.ts`、`src/reporting.ts` | 上下文、知识治理和通用用量记录 |
| `src/server.ts`、`ui/` | 本地 API 与工作台 |
| `templates/`、`prompts/` | 游戏模板、角色提示和执行合同 |
| `tests/`、`scripts/` | 回归、启动和打包 |


## 授权与来源

沿用本仓库 Apache-2.0 授权，必要上游声明见 `LICENSE` 与 `NOTICE`。
