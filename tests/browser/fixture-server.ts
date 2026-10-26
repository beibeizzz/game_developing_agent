import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('.local/tests', { recursive: true });
process.env.AGENT_DATA_DIR = mkdtempSync(resolve('.local/tests/browser-'));
process.env.ARK_AGENT_PLAN_API_KEY = '';
process.env.PORT = '18807';
process.env.PREVIEW_PORT = '18808';
const { createProject, artifact, put, uid } = await import('../../src/store.js');
const { now } = await import('../../src/config.js');
const p = createProject('双视图测试夹具', 'Synthetic UI fixture, no model requests.');
const task: any = {
  id: uid(),
  projectId: p.id,
  kind: 'production',
  instruction: p.idea,
  status: 'cancelled',
  stage: 'fixture',
  createdAt: now(),
  updatedAt: now(),
};
put('task', task);
const plan = artifact(
  task,
  'producer',
  '测试制作计划',
  {
    summary: 'Synthetic fixture',
    roles: ['research', 'planner'],
    reason: 'Testing artifact views',
    assumptions: [],
  },
  [],
);
artifact(
  task,
  'research',
  '测试调研',
  {
    summary: 'Synthetic reference fixture',
    candidates: [1, 2].map((i) => ({
      id: 'ref-' + i,
      title: 'Reference ' + i,
      url: 'https://example.com/',
      imageUrl: '',
      mechanics: 'Fixture',
      artDirection: 'Fixture',
    })),
    recommendation: 'Used only for UI testing',
  },
  [plan.id],
);
for (let i = 1; i <= 17; i++)
  artifact(
    task,
    'producer',
    `测试历史计划 ${i}`,
    {
      summary: 'Synthetic version history fixture',
      roles: ['research'],
      reason: 'Canvas history coverage',
      assumptions: [],
    },
    [plan.id],
  );
const opsProject = createProject('运营交互测试夹具', 'Synthetic proposal and experiment UI coverage.');
put('project', { ...opsProject, currentBuild: 'ui-baseline-build' });
const opsTask: any = { ...task, id: uid(), projectId: opsProject.id, kind: 'analysis' };
put('task', opsTask);
const proposalData = {
  title: '延长初始安全时间',
  diagnosis: '固定 Seed 的脚本基线表明初始安全时间可以单独验证。'.repeat(30),
  instruction: '将初始安全时间从 2 秒改为 3 秒，保持其余参数。',
  roles: ['level-design', 'level-code'],
  metric: 'survivalSeconds',
  source: 'script',
  seed: 1024,
  difficulty: 'normal',
  baseline: 40,
  targetMin: 41,
  targetMax: 43,
  windowMinutes: 0,
  minSamples: 1,
  guardrails: ['操作回归通过'],
  falsification: '观察值落在预测区间之外。',
  knowledgeIds: [],
  unresolved: [],
};
for (const status of ['rejected', 'approved']) {
  const item = artifact(
    opsTask,
    'proposal',
    status === 'approved' ? '延长安全时间方案' : '旧版安全时间方案',
    proposalData,
    [],
  );
  put('approval', {
    id: uid(),
    projectId: opsProject.id,
    taskId: opsTask.id,
    artifactId: item.id,
    status,
    feedback: status === 'rejected' ? '补充依据后修订' : '',
    createdAt: now(),
  });
}
const ideationTask: any = { ...opsTask, id: uid(), kind: 'ideation' };
put('task', ideationTask);
const idea = artifact(
  ideationTask,
  'ideation',
  '轨道躲避立项',
  {
    title: '轨道躲避立项',
    rationale: '操作更简单，用单键切换轨道验证玩法。',
    constraints: ['单机躲避游戏'],
    candidates: [{ title: '轨道躲避', idea: '按空格切换轨道躲避障碍。', evidence: ['synthetic-fixture'] }],
    challenges: ['验证操作提示'],
    selected: 0,
  },
  [],
);
put('approval', {
  id: uid(),
  projectId: opsProject.id,
  taskId: ideationTask.id,
  artifactId: idea.id,
  status: 'pending',
  feedback: '',
  createdAt: now(),
});
for (const source of ['human', 'script']) {
  put('experiment', {
    id: 'ui-experiment-' + source,
    projectId: opsProject.id,
    proposalId: 'fixture-' + source,
    baselineBuild: 'ui-baseline-build',
    baseline: 40,
    targetMin: 41,
    targetMax: 43,
    metric: 'survivalSeconds',
    source,
    seed: 1024,
    difficulty: 'normal',
    minSamples: 1,
    windowMinutes: 0,
    openedAt: now(),
    status: 'observing',
    candidateBuild: 'ui-candidate-build',
    candidateAt: '2026-01-01T00:00:00Z',
    guardrails: ['操作回归通过'],
    falsification: '观察值未命中预测区间。',
    knowledgeIds: [],
  });
}
await import('../../src/server.js');
