import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
mkdirSync('.local/tests', { recursive: true });
process.env.AGENT_DATA_DIR = mkdtempSync(resolve('.local/tests/operations-'));
process.env.ARK_AGENT_PLAN_API_KEY = '';
const store = await import('../src/store.js');
const { operations, runOperations } = await import('../src/operations.js');
const { registerExperiment } = await import('../src/evaluation.js');
const { now } = await import('../src/config.js');
const { createProject, put, list, uid, projectDir, required } = store;
const expert = (role: string, questions: string[] = []) => ({
  summary: role + ' synthetic observation',
  observations: ['fixture'],
  evidence: ['fixture evidence'],
  hypothesis: 'test only',
  changes: [{ file: 'game.mjs', change: 'fixture proposal' }],
  risks: [],
  questions,
});
function cache(task: any, id: string, result: any) {
  put('model-result', { id, projectId: task.projectId, result, source: 'synthetic-test-fixture' });
}
function session(projectId: string, seconds: number) {
  const sessionId = uid();
  for (const kind of ['start', 'game_over'])
    put('telemetry', {
      id: uid(),
      projectId,
      buildId: 'baseline',
      source: 'script',
      sessionId,
      seed: 1024,
      difficulty: 'normal',
      kind,
      data: { survivalSeconds: seconds },
      at: now(),
    });
}

test('operations freezes evidence, revises rejected proposals, and registers the approved frozen baseline', async () => {
  const project = createProject('Operations fixture', 'Synthetic operations test');
  put('project', { ...project, currentBuild: 'baseline' });
  const source = projectDir(project.id, 'builds', 'baseline', 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'game.mjs'), 'export const baseline = true;');
  const workspace = projectDir(project.id, 'workspaces', 'game');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'game.mjs'), 'export const unapproved = true;');
  session(project.id, 10);
  const task: any = {
    id: uid(),
    projectId: project.id,
    kind: 'analysis',
    instruction: 'Synthetic expert analysis; no cloud calls',
    status: 'running',
    stage: '',
    createdAt: now(),
    updatedAt: now(),
  };
  put('task', task);
  for (const role of ['pd', 'dev', 'reviewer']) {
    cache(task, task.id + '-' + role, expert(role));
    cache(
      task,
      `${task.id}-discussion-0-${role}`,
      expert(role, role === 'reviewer' ? ['Confirm evidence'] : []),
    );
    cache(task, `${task.id}-discussion-1-${role}`, expert(role));
  }
  cache(task, task.id + '-host', {
    title: 'Synthetic proposal',
    diagnosis: 'fixture hypothesis',
    evidence: ['fixture'],
    instruction: 'Adjust one fixture parameter',
    affectedRoles: ['game'],
    metric: 'survivalSeconds',
    source: 'script',
    seed: 1024,
    difficulty: 'normal',
    baseline: 999,
    targetMin: 12,
    targetMax: 20,
    minSamples: 1,
    windowMinutes: 0,
    guardrails: ['no errors'],
    falsification: 'outside interval',
    unresolved: [],
    knowledgeIds: [],
  });
  await runOperations(task, new AbortController().signal);
  assert.equal(required<any>('task', task.id).status, 'review');
  const state = await operations.getState({ configurable: { thread_id: task.id } });
  assert.equal(state.values.evidence.source['game.mjs'], 'export const baseline = true;');
  assert.equal(state.values.discussion.rounds.length, 2);
  let proposal = list<any>('artifact', project.id).find((a) => a.role === 'proposal')!;
  assert.equal(proposal.data.baseline, 10);
  const originalProposal = proposal;
  const rejected = list<any>('approval', project.id).at(-1)!;
  put('approval', {
    ...rejected,
    status: 'rejected',
    feedback: 'Synthetic review: narrow the prediction',
    decidedAt: now(),
  });
  cache(task, task.id + '-host-revision-1', {
    ...proposal.data,
    title: 'Revised synthetic proposal',
    targetMax: 18,
  });
  await runOperations(required('task', task.id), new AbortController().signal, rejected.id);
  const revisedState = await operations.getState({ configurable: { thread_id: task.id } });
  assert.equal(revisedState.values.revision, 1);
  assert.equal(revisedState.values.feedback, 'Synthetic review: narrow the prediction');
  assert.deepEqual(revisedState.values.independent, state.values.independent);
  assert.equal(required<any>('task', task.id).status, 'review');
  const versions = list<any>('artifact', project.id).filter((a) => a.role === 'proposal');
  assert.equal(versions.length, 2);
  proposal = versions.at(-1)!;
  assert.equal(proposal.version, 2);
  assert.ok(proposal.inputVersions.includes(originalProposal.id));
  assert.equal(proposal.data.targetMax, 18);
  assert.equal(required<any>('approval', rejected.id).status, 'rejected');
  session(project.id, 100); // Later observations cannot silently change the approved analysis batch.
  const approval = list<any>('approval', project.id).at(-1)!;
  put('approval', {
    ...approval,
    status: 'approved',
    feedback: 'Synthetic approval in isolated test',
    decidedAt: now(),
  });
  await runOperations(required('task', task.id), new AbortController().signal, approval.id);
  assert.equal(required<any>('task', task.id).status, 'completed');
  const experiment = registerExperiment(project.id, proposal.id);
  assert.equal(experiment.baseline, 10);
  assert.equal(experiment.baselineEvidence?.batchId, task.id + '-batch');
});

test('new-game ideation uses separate candidate contract and remains pending human review', async () => {
  const project = createProject('Ideation fixture', 'Synthetic dodge idea');
  const task: any = {
    id: uid(),
    projectId: project.id,
    kind: 'ideation',
    instruction: 'Synthetic new-game brief',
    status: 'running',
    stage: '',
    createdAt: now(),
    updatedAt: now(),
  };
  put('task', task);
  for (const role of ['analyst', 'gd', 'reviewer']) {
    cache(task, task.id + '-' + role, expert(role));
    cache(task, `${task.id}-discussion-0-${role}`, expert(role));
  }
  cache(task, task.id + '-host', {
    title: 'New dodge candidates',
    constraints: ['local single-player'],
    candidates: [
      { title: 'A', idea: 'Synthetic A', evidence: ['fixture'] },
      { title: 'B', idea: 'Synthetic B', evidence: ['fixture'] },
    ],
    selected: 1,
    challenges: ['fixture limitation'],
    rationale: 'test contract',
  });
  await runOperations(task, new AbortController().signal);
  assert.equal(required<any>('task', task.id).status, 'review');
  const artifacts = list<any>('artifact', project.id);
  assert.ok(artifacts.some((a) => a.role === 'ideation' && a.data.selected === 1));
  assert.equal(artifacts.filter((a) => a.role === 'proposal').length, 0);
  assert.equal(list<any>('approval', project.id)[0].status, 'pending');
});
test.after(() => store.db.close());
