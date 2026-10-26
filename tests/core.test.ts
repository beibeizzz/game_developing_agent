import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
mkdirSync('.local/tests', { recursive: true });
process.env.AGENT_DATA_DIR = mkdtempSync(resolve('.local/tests/core-'));
process.env.ARK_AGENT_PLAN_API_KEY = '';
const store = await import('../src/store.js');
const memory = await import('../src/memory.js');
const evaluation = await import('../src/evaluation.js');
const { wav } = await import('../src/tools.js');
const { mediaTools } = await import('../src/tools.js');
const { now } = await import('../src/config.js');
const { productionRoles } = await import('../src/routing.js');
const { createProject, put, get, list, required, uid, acquire, release, activeTask, artifact, events } =
  store;

test('image generation rejects assets outside the approved GDD before making a cloud request', async () => {
  const p = createProject('Asset scope', 'synthetic test');
  const tool = mediaTools({ id: uid(), projectId: p.id } as any, undefined, ['player']).find(
    (t) => t.name === 'generate_image',
  )!;
  await assert.rejects(
    tool.run({
      id: 'procedural_background',
      prompt: 'extra image',
      references: [],
      transparentSprite: false,
    }),
    /GDD/,
  );
  assert.equal(list('asset', p.id).length, 0);
});

test('local presentation changes preserve levels while changed level contracts include implementation', () => {
  assert.deepEqual(productionRoles(['game'], 'modify', true), ['game']);
  assert.deepEqual(productionRoles(['art'], 'modify', true), ['art', 'game']);
  assert.deepEqual(productionRoles(['game', 'level-design'], 'modify', true), [
    'game',
    'level-design',
    'level-code',
  ]);
  assert.deepEqual(productionRoles(['level-code'], 'modify', true), ['level-code']);
  assert.equal(productionRoles(['game'], 'create', false).length, 7);
  assert.deepEqual(productionRoles(['game'], 'consult', false), []);
});

test('project ownership and path boundaries are maintained', () => {
  const a = createProject('A', 'test dodge idea'),
    b = createProject('B', 'another dodge idea');
  put('reference', { id: uid(), projectId: a.id, title: 'only A' });
  assert.equal(list('reference', a.id).length, 1);
  assert.equal(list('reference', b.id).length, 0);
  assert.throws(() => store.projectDir(a.id, '../../outside'), /路径越界/);
  assert.throws(() => store.projectDir('../bad'), /标识/);
});
test('global task execution lock is exclusive and owner released', () => {
  acquire('task-a');
  assert.equal(activeTask(), 'task-a');
  assert.throws(() => acquire('task-b'), /另一个/);
  release('task-b');
  assert.equal(activeTask(), 'task-a');
  release('task-a');
  assert.equal(activeTask(), undefined);
});
test('artifact stable job identity prevents duplicate versions after node replay', () => {
  const p = createProject('C', 'test');
  const t: any = { id: uid(), projectId: p.id };
  const first = artifact(t, 'planner', 'plan', { value: 1 }, [], 'stable-artifact');
  const replay = artifact(t, 'planner', 'plan', { value: 2 }, [], 'stable-artifact');
  assert.deepEqual(replay, first);
  assert.equal(list('artifact', p.id).length, 1);
  assert.equal(artifact(t, 'planner', 'revision', {}, [first.id]).version, 2);
});
test('knowledge changes stay pending, approved revisions retire previous version and preserve evidence', () => {
  const p = createProject('Memory', 'dodge');
  const first = memory.proposeKnowledge(p.id, {
    action: 'add',
    title: 'Movement',
    content: 'Clamp by radius',
    evidence: ['e1'],
    scope: 'production',
  });
  assert.equal(first.status, 'pending');
  memory.reviewKnowledge(first.id, true, 'checked');
  const revision = memory.proposeKnowledge(p.id, {
    action: 'revise',
    previousId: first.id,
    title: first.title,
    content: 'New observed condition',
    evidence: ['e1', 'e2'],
    counterEvidence: ['e2'],
  });
  assert.equal(get<any>('knowledge', first.id).status, 'approved');
  memory.reviewKnowledge(revision.id, true, 'counterevidence reviewed');
  assert.equal(get<any>('knowledge', first.id).status, 'retired');
  assert.equal(get<any>('knowledge', revision.id).version, 2);
  assert.throws(() => memory.reviewKnowledge(revision.id, false, ''), /已处理/);
  const other = createProject('Other', 'dodge');
  assert.throws(
    () =>
      memory.proposeKnowledge(other.id, {
        action: 'revise',
        previousId: revision.id,
        title: 'bad',
        content: 'bad',
        evidence: ['e3'],
      }),
    /不一致/,
  );
});
test('memory loads task handbook, approved knowledge and provenance; pending knowledge remains excluded', () => {
  const p = createProject('Memory read', 'dodge');
  const a = memory.proposeKnowledge(p.id, {
    action: 'add',
    title: 'A',
    content: 'A',
    evidence: ['event-1'],
    scope: 'production',
  });
  const b = memory.proposeKnowledge(p.id, {
    action: 'add',
    title: 'B',
    content: 'B',
    evidence: ['event-2'],
    scope: 'production',
  });
  memory.reviewKnowledge(a.id, true, 'verified');
  const ctx = memory.contextFor(
    { id: 'memory-task', projectId: p.id, instruction: 'dodge' } as any,
    'planner',
  );
  assert.ok(ctx.core.includes('核心规则'));
  assert.ok(ctx.handbook.includes('生产任务手册'));
  assert.ok(ctx.knowledge.some((x) => x.id === a.id));
  assert.ok(!ctx.knowledge.some((x) => x.id === b.id));
  assert.ok(events(p.id).some((e) => e.kind === 'memory-read'));
});
function fixture(
  projectId: string,
  buildId: string,
  source: 'human' | 'script',
  seconds: number,
  seed = 1024,
) {
  const sessionId = uid();
  for (const kind of ['start', 'game_over'])
    put('telemetry', {
      id: uid(),
      projectId,
      buildId,
      source,
      sessionId,
      seed,
      difficulty: 'normal',
      kind,
      data: { survivalSeconds: seconds },
      at: now(),
    });
}
test('metrics keep source, build and seed separate and require complete sessions', () => {
  const p = createProject('Metrics', 'dodge');
  fixture(p.id, 'v1', 'human', 12);
  fixture(p.id, 'v1', 'script', 90);
  fixture(p.id, 'v2', 'human', 40);
  fixture(p.id, 'v1', 'human', 77, 999);
  const m = evaluation.metrics(p.id, 'v1', 'human', 1024);
  assert.deepEqual(m.survivalSeconds, [12]);
  assert.equal(m.completedSessions, 1);
});
test('batch gate rejects empty evidence and freezes exact build data', () => {
  const p = createProject('Batch', 'dodge');
  assert.throws(() => evaluation.createBatch(p.id, 'a'), /已批准/);
  put('project', { ...p, currentBuild: 'v1' });
  assert.throws(() => evaluation.createBatch(p.id, 'b'), /数据门禁/);
  fixture(p.id, 'v1', 'human', 20);
  const batch = evaluation.createBatch(p.id, 'c');
  fixture(p.id, 'v1', 'human', 30);
  assert.equal(get<any>('batch', batch.id).human.completedSessions, 1);
  assert.equal(batch.hash.length, 64);
});
test('experiment registration uses real baseline and requires approved proposal', () => {
  const p = createProject('Register', 'dodge');
  put('project', { ...p, currentBuild: 'base' });
  fixture(p.id, 'base', 'human', 10);
  const proposal = put('artifact', {
    id: uid(),
    projectId: p.id,
    role: 'proposal',
    data: {
      baseline: 999,
      metric: 'survivalSeconds',
      source: 'human',
      seed: 1024,
      targetMin: 12,
      targetMax: 20,
      minSamples: 1,
      windowMinutes: 0,
      guardrails: ['no errors'],
      falsification: 'outside range',
      knowledgeIds: [],
    },
  });
  assert.throws(() => evaluation.registerExperiment(p.id, proposal.id), /审核/);
  put('approval', { id: uid(), projectId: p.id, artifactId: proposal.id, status: 'approved' });
  const e = evaluation.registerExperiment(p.id, proposal.id);
  assert.equal(e.baseline, 10);
  assert.equal(evaluation.registerExperiment(p.id, proposal.id).id, e.id);
});
for (const [name, seconds, samples, guardrails, expected] of [
  ['positive', 15, 2, true, 'positive'],
  ['negative', 5, 2, true, 'negative'],
  ['mixed', 15, 2, false, 'mixed'],
  ['insufficient', 15, 1, true, 'insufficient'],
] as const)
  test(`settlement ${name} preserves samples and creates pending knowledge`, () => {
    const p = createProject('Settlement ' + name, 'dodge');
    const proposal = put('artifact', {
      id: uid(),
      projectId: p.id,
      data: { title: 'change', diagnosis: 'hypothesis' },
    });
    const e = put('experiment', {
      id: uid(),
      projectId: p.id,
      proposalId: proposal.id,
      baselineBuild: 'base',
      candidateBuild: 'candidate',
      baseline: 10,
      metric: 'survivalSeconds',
      source: 'human',
      seed: 1024,
      targetMin: 12,
      targetMax: 20,
      minSamples: 2,
      windowMinutes: 0,
      openedAt: now(),
      candidateAt: now(),
      status: 'observing',
      guardrails: ['no errors'],
      falsification: 'outside range',
      knowledgeIds: [],
    });
    for (let i = 0; i < samples; i++) fixture(p.id, 'candidate', 'human', seconds);
    const result: any = evaluation.settleExperiment(e.id, {
      guardrailsPassed: guardrails,
      evidence: 'script fixture observation',
    });
    assert.equal(result.settlement.classification, expected);
    assert.equal(list<any>('knowledge', p.id)[0].status, 'pending');
    assert.equal(evaluation.settleExperiment(e.id).id, e.id);
    assert.equal(list('knowledge', p.id).length, 1);
  });
test('settlement waits for observation window and explicit guardrail evidence', () => {
  const p = createProject('Window', 'dodge');
  const e = put('experiment', {
    id: uid(),
    projectId: p.id,
    candidateBuild: 'candidate',
    candidateAt: now(),
    windowMinutes: 60,
    status: 'observing',
  });
  assert.match((evaluation.settleExperiment(e.id) as any).pendingReason, /窗口/);
});
test('procedural audio produces valid PCM WAV with bounded samples', () => {
  const audio = wav(Float32Array.from([0, 0.5, -0.5, 2, -2]), 16000);
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF');
  assert.equal(audio.readUInt32LE(24), 16000);
  assert.equal(audio.readUInt32LE(40), 10);
  assert.equal(audio.readInt16LE(50), 32767);
  assert.equal(audio.readInt16LE(52), -32767);
});

test('missing settlement evidence rolls back settlement and knowledge atomically', () => {
  const p = createProject('Atomic settlement', 'fixture');
  const e = put('experiment', {
    id: uid(),
    projectId: p.id,
    proposalId: 'missing-proposal',
    candidateBuild: 'candidate',
    candidateAt: now(),
    baseline: 1,
    metric: 'survivalSeconds',
    source: 'script',
    seed: 1024,
    minSamples: 1,
    targetMin: 1,
    targetMax: 20,
    windowMinutes: 0,
    status: 'observing',
    guardrails: [],
    knowledgeIds: [],
  });
  fixture(p.id, 'candidate', 'script', 10);
  assert.throws(() => evaluation.settleExperiment(e.id), /不存在/);
  assert.equal(get<any>('experiment', e.id).status, 'observing');
  assert.equal(events(p.id).filter((e) => e.kind === 'settlement').length, 0);
});

test('metrics separate difficulty and default knowledge proposals remain pending', () => {
  const p = createProject('Cohorts', 'fixture');
  fixture(p.id, 'v1', 'human', 15);
  const sessionId = uid();
  for (const kind of ['start', 'game_over'])
    put('telemetry', {
      id: uid(),
      projectId: p.id,
      buildId: 'v1',
      source: 'human',
      sessionId,
      seed: 1024,
      difficulty: 'hard',
      kind,
      data: { survivalSeconds: 3 },
      at: now(),
    });
  assert.deepEqual(evaluation.metrics(p.id, 'v1', 'human', 1024, 'normal').survivalSeconds, [15]);
  assert.deepEqual(evaluation.metrics(p.id, 'v1', 'human', 1024, 'hard').survivalSeconds, [3]);
  const k = memory.proposeKnowledge(p.id, {
    title: 'Draft',
    content: 'Draft observation',
    evidence: ['synthetic-case'],
  });
  assert.equal(k.action, 'add');
  assert.equal(k.status, 'pending');
});

test('game packaging excludes internal context and stale assets', () => {
  const root = mkdtempSync(resolve('.local/tests/package-'));
  mkdirSync(join(root, 'assets'));
  mkdirSync(join(root, 'dist'));
  cpSync('templates/game/build.mjs', join(root, 'build.mjs'));
  writeFileSync(join(root, 'index.html'), '<h1>synthetic packaging fixture</h1>');
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ internal: 'context-must-stay-private' }));
  writeFileSync(
    join(root, 'asset-manifest.json'),
    JSON.stringify({ images: [{ file: 'assets/selected.png' }], audio: [] }),
  );
  writeFileSync(join(root, 'assets/selected.png'), 'selected fixture');
  writeFileSync(join(root, 'assets/rejected.png'), 'rejected fixture');
  writeFileSync(join(root, 'dist/old-private.json'), 'stale build');
  execFileSync(process.execPath, ['build.mjs'], { cwd: root });
  assert.ok(existsSync(join(root, 'dist/assets/selected.png')));
  for (const file of ['contract.json', 'old-private.json', 'assets/rejected.png'])
    assert.equal(existsSync(join(root, 'dist', file)), false, file);
});

test('both coder workspaces receive approved memory and task handbook with provenance', async () => {
  const { seedWorkspace } = await import('../src/coder.js');
  const p = createProject('Coder memory', 'synthetic fixture');
  const task: any = { id: uid(), projectId: p.id, instruction: 'dodge code change' };
  const approved = memory.proposeKnowledge(p.id, {
    title: 'Approved boundary observation',
    content: 'Fixture evidence',
    scope: 'production',
    tags: ['dodge'],
    evidence: ['synthetic-memory-fixture'],
  });
  memory.reviewKnowledge(approved.id, true, 'synthetic test approval');
  const pending = memory.proposeKnowledge(p.id, {
    title: 'Pending observation',
    content: 'Keep pending',
    scope: 'production',
    tags: ['dodge'],
    evidence: ['synthetic-memory-fixture'],
  });
  for (const role of ['game', 'level-code'] as const) {
    const dir = seedWorkspace(task, role, {});
    const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8'));
    assert.ok(contract.memory.core.includes('核心规则'));
    assert.ok(contract.memory.handbook.includes('生产任务手册'));
    assert.equal(contract.memory.session.role, role);
    assert.ok(contract.memory.knowledge.some((k: any) => k.id === approved.id));
    assert.ok(!contract.memory.knowledge.some((k: any) => k.id === pending.id));
    assert.ok(store.events(p.id).some((e: any) => e.kind === 'memory-read' && e.data.role === role));
    if (role === 'game') writeFileSync(join(dir, 'game.test.mjs'), 'existing game regression suite');
    else assert.equal(readFileSync(join(dir, 'game.test.mjs'), 'utf8'), 'existing game regression suite');
  }
});

test('completed level job reapplies handoff after a host interruption', async () => {
  const { runCoder } = await import('../src/coder.js');
  const p = createProject('Level handoff', 'fixture');
  const task: any = { id: uid(), projectId: p.id };
  const level = store.projectDir(p.id, 'workspaces', 'level-code');
  mkdirSync(level, { recursive: true });
  mkdirSync(store.projectDir(p.id, 'workspaces', 'game'), { recursive: true });
  for (const file of ['level.mjs', 'level.test.mjs', 'LEVEL_INTERFACE.md'])
    writeFileSync(join(level, file), 'synthetic handoff file');
  writeFileSync(
    join(level, 'game-config.json'),
    JSON.stringify({ playerSpeed: 999, level: { safetySeconds: 3.5 } }),
  );
  const gameConfig = store.projectDir(p.id, 'workspaces', 'game', 'game-config.json');
  writeFileSync(
    gameConfig,
    JSON.stringify({ playerSpeed: 260, title: 'preserve game', level: { safetySeconds: 2 } }),
  );
  put('job', {
    id: 'completed-level-fixture',
    projectId: p.id,
    status: 'completed',
    result: { marker: 'cached SDK result' },
  });
  const result = await runCoder(
    task,
    'level-code',
    {},
    'completed-level-fixture',
    new AbortController().signal,
  );
  assert.equal(result.marker, 'cached SDK result');
  assert.deepEqual(JSON.parse(readFileSync(gameConfig, 'utf8')), {
    playerSpeed: 260,
    title: 'preserve game',
    level: { safetySeconds: 3.5 },
  });
  assert.equal(
    readFileSync(store.projectDir(p.id, 'workspaces', 'game', 'level.mjs'), 'utf8'),
    'synthetic handoff file',
  );
});
test.after(() => store.db.close());

test('completed worker result is reconciled before any new container launch', async () => {
  const { runCoder } = await import('../src/coder.js');
  const p = createProject('Worker reconciliation', 'fixture');
  const task: any = { id: uid(), projectId: p.id };
  const key = uid();
  const state = store.projectDir(p.id, 'sessions', 'game');
  mkdirSync(state, { recursive: true });
  const result = { status: 'completed', sessionId: 'synthetic-session', result: { summary: 'fixture' } };
  writeFileSync(join(state, key + '.result.json'), JSON.stringify(result));
  put('job', {
    id: key,
    projectId: p.id,
    taskId: task.id,
    role: 'game',
    status: 'running',
    createdAt: now(),
  });
  assert.deepEqual(await runCoder(task, 'game', {}, key, new AbortController().signal), result);
  assert.equal(get<any>('job', key).status, 'completed');
});
