import { readFileSync } from 'node:fs';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { config, now } from './config.js';
import {
  approvedArtifacts,
  artifact,
  event,
  get,
  list,
  put,
  required,
  taskUpdate,
  projectDir,
} from './store.js';
import {
  schemas,
  roleLabels,
  type Artifact,
  type Approval,
  type Role,
  type Task,
  type Project,
} from './contracts.js';
import { modelRole } from './model.js';
import { mediaTools, researchTools, assetPath, sourceSnapshot } from './tools.js';
import { runCoder } from './coder.js';
import { deliver } from './delivery.js';
import { productionRoles } from './routing.js';

const State = Annotation.Root({
  taskId: Annotation<string>(),
  plan: Annotation<Role[]>(),
  cursor: Annotation<number>(),
  attempt: Annotation<number>(),
  inputs: Annotation<Record<string, Artifact>>(),
  current: Annotation<string>(),
  feedback: Annotation<string>(),
  decision: Annotation<string>(),
  consult: Annotation<boolean>(),
});
const saver = SqliteSaver.fromConnString(join(config.data, 'graph.sqlite'));
const controllers = new Map<string, AbortSignal>();
const signals = (taskId: string) => controllers.get(taskId) || new AbortController().signal;
const approvalRoles = new Set(['research', 'planner', 'art', 'level-design']);
const directions: Record<string, string> = {
  research:
    '执行联网调研，调用 search_references 取得真实来源和参考图片，可读用户本地参考。输出 2–3 个躲避玩法/美术方向。URL 和 imageUrl 必须来自工具结果或本地参考。优先有图片的结果。每个候选写清来源实际描述的规则和美术方向；为当前躲避游戏提出的改造建议标记为“本作适配建议”，截图观察与推断分别表述。',
  planner:
    '根据用户选定参考和目标产出完整高密度 GDD，明确操作、移动边界、暂停/重开、碰撞、三种难度、离线运行和实际验收条目。区分程序绘制与图片资产，首款游戏图片资产控制在必要的玩家、障碍和背景。严格遵循 executionContract 的固化壳与 generateLevel/validateLevel/waves 关卡接口。菜单、暂停、重开、静音由壳提供按钮；扩展快捷键需明确交由壳实现。正常游玩隐藏受击环和碰撞调试轮廓；碰撞几何、贴图可见主体尺寸与透明边距补偿在设计和测试中明确，发光只作装饰。视觉尺寸与碰撞半径分别记录，碰撞几何变化须联动关卡可避让验证。固定验收范围，附加功能单列为后续。',
  art: '先读取 GDD 和已有素材。只生成 GDD assets 中 kind=image 的资源，并严格保持 ID；kind=procedural 的背景、粒子、UI 由 Game Coder 绘制。正常游玩隐藏受击环和碰撞调试轮廓。最终 assets 精确覆盖 image 清单。首张风格锚点随后作为 references，实体变体保留 Entity 引用。单个精灵使用透明处理。局部改动复用已有未受影响文件。必须调用 compose_layout 合成游戏页面框架，再调用 inspect_layout 分析实际图像。最终 assets 和 frameFile 引用真实文件，layout 给出坐标。',
  audio:
    '根据 GDD 按类别实际调用工具制作音频。使用程序合成 BGM 和交互/状态/UI 效果音，语音用 synthesize_speech；只在 GDD 需要时生成语音。记录各资源触发点和循环。复用未受影响音频，返回真实文件路径。',
  'level-design':
    '读取已实现 GAME_INTERFACE.md 和真实游戏代码，输出五章关卡工厂方案：gameType、dataStructure、production、validation、difficultyCurve。固定 Seed 与参数可复现。验证必须说明玩家速度/半径、时间/轨迹的可避让假设。模式 runtime 或 prebuilt 在 production.mode 明确。三种难度需产生可测差异。',
};
function cacheId(s: typeof State.State, role: string) {
  return `${s.taskId}-${s.cursor}-${s.attempt}-${role}`;
}
function validateMedia(projectId: string, data: any) {
  for (const a of data.assets || []) readFileSync(assetPath(projectId, a.file));
  if (data.frameFile) readFileSync(assetPath(projectId, data.frameFile));
}
export const production = new StateGraph(State)
  .addNode('producer', async (s) => {
    const task = required<Task>('task', s.taskId);
    taskUpdate(task.id, { stage: 'producer' });
    const inputs = approvedArtifacts(task.projectId);
    const plan = await modelRole(
      task,
      'producer',
      '你负责意图识别和受影响角色路由。创建新游戏时 roles 按 research,planner,art,audio,game,level-design,level-code 排序包含全部角色。局部修改只选受影响角色，并解释复用依据。consult 返回咨询说明；修改游戏代码必须包含 game。纯视觉、提示文案、音量与渲染尺寸修改可复用关卡。改变碰撞半径、移动速度、障碍种类/轨迹、生成参数或 GAME_INTERFACE 关卡接口时，必须包含 level-design 和 level-code，重新核对可避让假设。读取实际源码判断变更影响；区分装饰大小和碰撞大小。已有获批关卡方案的实现修复可只选 level-code。',
      {
        instruction: task.instruction,
        existing: inputs,
        source: task.kind === 'iteration' ? sourceSnapshot(task.projectId) : undefined,
      },
      schemas.producer,
      [],
      signals(task.id),
      task.id + '-producer',
    );
    const selected = productionRoles(plan.roles, plan.intent, !!inputs.game);
    const currentPlan = artifact(
      task,
      'producer',
      '执行计划',
      { ...plan, roles: selected },
      Object.values(inputs).map((a) => a.id),
      task.id + '-plan',
    );
    if (!selected.length && plan.intent !== 'consult') throw new Error('Producer 未选择执行角色');
    return {
      plan: selected,
      cursor: 0,
      attempt: 0,
      inputs: { ...inputs, producer: currentPlan },
      feedback: '',
      current: '',
      decision: '',
      consult: plan.intent === 'consult',
    };
  })
  .addNode('execute', async (s) => {
    signals(s.taskId).throwIfAborted();
    const task = required<Task>('task', s.taskId);
    const role = s.plan[s.cursor];
    const key = cacheId(s, role);
    taskUpdate(task.id, { stage: role });
    const cached = get<Artifact>('artifact', key);
    if (cached) return { current: cached.id, inputs: { ...s.inputs, [role]: cached } };
    const input = {
      idea: required<Project>('project', task.projectId).idea,
      instruction: task.instruction,
      artifacts: s.inputs,
      feedback: s.feedback,
      approvals: list<Approval>('approval', task.projectId).filter((a) => a.status === 'approved'),
      localReferences: list('reference', task.projectId),
    };
    let data: any;
    if (role === 'game' || role === 'level-code')
      data = await runCoder(task, role, s.inputs, key, signals(task.id));
    else {
      let extra: any = {
        executionContract: readFileSync(join(config.root, 'templates/CODER_CONTRACT.md'), 'utf8'),
      };
      if (role === 'level-design')
        extra = {
          ...extra,
          implementedInterface: readFileSync(
            projectDir(task.projectId, 'workspaces/game/GAME_INTERFACE.md'),
            'utf8',
          ),
          source: sourceSnapshot(task.projectId),
        };
      const tools =
        role === 'research'
          ? researchTools(task)
          : role === 'art'
            ? mediaTools(
                task,
                signals(task.id),
                (s.inputs.planner?.data.assets || [])
                  .filter((a: any) => a.kind === 'image')
                  .map((a: any) => a.id),
              ).filter((t) =>
                ['generate_image', 'compose_layout', 'inspect_layout', 'list_assets'].includes(t.name),
              )
            : role === 'audio'
              ? mediaTools(task, signals(task.id)).filter((t) =>
                  ['synthesize_audio', 'synthesize_speech', 'list_assets'].includes(t.name),
                )
              : [];
      data = await modelRole(
        task,
        role,
        directions[role],
        { ...input, ...extra },
        schemas[role] as any,
        tools,
        signals(task.id),
        key,
        (result: any) => {
          if (role === 'art' || role === 'audio') validateMedia(task.projectId, result);
          if (role === 'art') {
            const expected = (s.inputs.planner?.data.assets || []).filter((a: any) => a.kind === 'image');
            if (expected.some((a: any) => !result.assets.some((b: any) => b.id === a.id)))
              throw new Error('美术输出必须覆盖 GDD 的每个图片资产 ID。');
            if (
              result.assets.length !== expected.length ||
              result.assets.some((a: any) => !expected.some((b: any) => a.id === b.id))
            )
              throw new Error('美术 assets 必须与 GDD 的 image 清单一致；procedural 资源由代码绘制。');
            const composed = list<any>('asset', task.projectId).some(
              (a) => a.file === result.frameFile && a.source === 'composed-from-generated-assets',
            );
            const inspected = list<any>('visual-inspection', task.projectId).some(
              (a) => a.file === result.frameFile,
            );
            if (!composed || !inspected)
              throw new Error('请完成 compose_layout 和 inspect_layout，输出对应的真实框架图与观测。');
          }
          if (
            role === 'planner' &&
            !['generateLevel', 'validateLevel'].every((name) => result.levelInterface.includes(name))
          )
            throw new Error(
              '关卡设计须使用 executionContract 的 generateLevel / validateLevel 接口和 waves 数据合同。',
            );
          if (role === 'research') {
            const sources = list<any>('research-source', task.projectId)
              .flatMap((r) => r.results)
              .concat(list<any>('reference', task.projectId));
            if (
              !result.candidates.every((c: any) =>
                sources.some((r) => r.url === c.url && r.imageUrl === c.imageUrl),
              )
            )
              throw new Error(
                '候选 URL/图片必须来自实际 search_references 或 local_references 工具结果；请先调用工具。',
              );
          }
        },
      );
    }
    const value = artifact(
      task,
      role,
      roleLabels[role],
      data,
      Object.values(s.inputs).map((a) => a.id),
      key,
    );
    return { current: value.id, inputs: { ...s.inputs, [role]: value } };
  })
  .addNode('review', (s) => {
    signals(s.taskId).throwIfAborted();
    const task = required<Task>('task', s.taskId);
    const current = required<Artifact>('artifact', s.current);
    const id = current.id + '-review';
    const approval =
      get<Approval>('approval', id) ||
      put<Approval>('approval', {
        id,
        projectId: task.projectId,
        taskId: task.id,
        artifactId: current.id,
        status: 'pending',
        feedback: '',
        createdAt: now(),
      });
    taskUpdate(task.id, { status: 'review', stage: current.role });
    const decision = interrupt({
      approvalId: id,
      artifactId: current.id,
      version: current.version,
      role: current.role,
    });
    const saved = required<Approval>('approval', id);
    if (decision.approvalId !== id || saved.status === 'pending') throw new Error('审核版本与恢复参数不一致');
    taskUpdate(task.id, { status: 'running' });
    return {
      decision: saved.status,
      feedback: saved.feedback,
      attempt: saved.status === 'rejected' ? s.attempt + 1 : s.attempt,
      inputs: { ...s.inputs, producer: required<Artifact>('artifact', task.id + '-plan') },
    };
  })
  .addNode('advance', (s) => ({ cursor: s.cursor + 1, attempt: 0, feedback: '', decision: '' }))
  .addNode('delivery', async (s) => {
    const task = required<Task>('task', s.taskId);
    taskUpdate(task.id, { stage: 'delivery' });
    const build = await deliver(task, task.id + '-build', signals(task.id));
    const value = artifact(
      task,
      'delivery',
      '游戏预览与交付',
      build,
      Object.values(s.inputs).map((a) => a.id),
      task.id + '-delivery',
    );
    return { current: value.id };
  })
  .addNode('done', (s) => {
    signals(s.taskId).throwIfAborted();
    const task = required<Task>('task', s.taskId);
    if (!s.consult) {
      const value = required<Artifact>('artifact', s.current);
      const build = value.data;
      const project = required<Project>('project', task.projectId);
      put('project', { ...project, currentBuild: build.id, updatedAt: now() });
      put('build', { ...build, status: 'approved' });
      if (task.experimentId) {
        const experiment = required('experiment', task.experimentId);
        put('experiment', {
          ...experiment,
          candidateBuild: build.id,
          candidateAt: now(),
          status: 'observing',
        });
      }
    }
    taskUpdate(task.id, { status: 'completed', stage: 'completed', error: undefined });
    return {};
  })
  .addEdge(START, 'producer')
  .addConditionalEdges('producer', (s) => (s.consult ? 'done' : 'execute'), ['done', 'execute'])
  .addConditionalEdges('execute', (s) => (approvalRoles.has(s.plan[s.cursor]) ? 'review' : 'advance'), [
    'review',
    'advance',
  ])
  .addConditionalEdges(
    'review',
    (s) =>
      s.decision === 'rejected'
        ? required<Artifact>('artifact', s.current).role === 'delivery'
          ? END
          : 'execute'
        : required<Artifact>('artifact', s.current).role === 'delivery'
          ? 'done'
          : 'advance',
    [END, 'execute', 'done', 'advance'],
  )
  .addConditionalEdges('advance', (s) => (s.cursor < s.plan.length ? 'execute' : 'delivery'), [
    'execute',
    'delivery',
  ])
  .addEdge('delivery', 'review')
  .addEdge('done', END)
  .compile({ checkpointer: saver });

export async function runProduction(task: Task, signal: AbortSignal, approvalId?: string) {
  const settings = { configurable: { thread_id: task.id }, recursionLimit: 150 };
  controllers.set(task.id, signal);
  try {
    const snapshot = await production.getState(settings);
    await production.invoke(
      approvalId
        ? new Command({ resume: { approvalId } })
        : Object.keys(snapshot.values || {}).length
          ? null
          : { taskId: task.id },
      settings,
    );
    const current = required<Task>('task', task.id);
    if (current.status === 'running')
      taskUpdate(task.id, {
        status: 'completed',
        stage: 'rejected',
        error: '交付已驳回；请以反馈创建修改任务。',
      });
  } finally {
    controllers.delete(task.id);
  }
}
