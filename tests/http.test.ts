import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
mkdirSync('.local/tests', { recursive: true });
process.env.AGENT_DATA_DIR = mkdtempSync(resolve('.local/tests/http-'));
process.env.ARK_AGENT_PLAN_API_KEY = '';
const store = await import('../src/store.js');
const { now } = await import('../src/config.js');
const { put, get, list, createProject, uid } = store;
const port = 18797,
  previewPort = 18798,
  base = `http://127.0.0.1:${port}`;
let child: ChildProcess;
let stderr = '';
async function startServer() {
  child = spawn(process.execPath, ['--import', 'tsx', resolve('src/server.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      PREVIEW_PORT: String(previewPort),
      ARK_AGENT_PLAN_API_KEY: '',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', (data) => (stderr += data));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Test server failed: ' + stderr);
}
async function stopServer() {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await exited;
  }
}
async function request(path: string, data?: any, headers: Record<string, string> = {}) {
  const response = await fetch(base + '/api' + path, {
    ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  return { status: response.status, data: await response.json() };
}
async function waitForTask(id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    const task = get<any>('task', id);
    if (task?.status === status) return task;
    if (task?.status === 'failed') throw new Error(task.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Task state timeout: ' + JSON.stringify(get('task', id)));
}
test.before(startServer);
test.after(async () => {
  await stopServer();
  store.db.close();
});
test('HTTP rejects cross-origin mutations and keeps credentials out of status', async () => {
  const response = await request(
    '/projects',
    { name: 'blocked', idea: 'blocked idea' },
    { Origin: 'https://external.invalid' },
  );
  assert.equal(response.status, 403);
  const status = await request('/status');
  assert.equal(status.data.configured, false);
  assert.ok(!('token' in status.data));
});
test('HTTP validates project input and retains archived project without data loss', async () => {
  assert.equal((await request('/projects', { name: '', idea: 'test' })).status, 400);
  const p = (await request('/projects', { name: 'HTTP fixture', idea: 'scripted workspace fixture' })).data;
  await request(`/projects/${p.id}/archive`, { archived: true });
  const detail = await request('/projects/' + p.id);
  assert.equal(detail.data.project.archived, true);
  assert.equal(detail.data.project.idea, p.idea);
});
test('real LangGraph approval survives host restart, rejected version regenerates, stale approvals fail', async () => {
  const p = createProject('Workflow fixture', 'synthetic dodge requirement');
  const id = uid();
  const oldPlanId = uid();
  put('artifact', {
    id: oldPlanId,
    projectId: p.id,
    taskId: 'previous-fixture-task',
    role: 'producer',
    title: 'Previous plan fixture',
    data: { roles: ['game'] },
    inputVersions: [],
    version: 1,
    createdAt: now(),
  });
  put('task', {
    id,
    projectId: p.id,
    kind: 'production',
    instruction: 'synthetic workflow fixture, no cloud calls',
    status: 'queued',
    stage: 'queued',
    createdAt: now(),
    updatedAt: now(),
  });
  put('model-result', {
    id: id + '-producer',
    projectId: p.id,
    result: {
      intent: 'create',
      summary: 'fixture',
      roles: ['research', 'planner', 'art', 'audio', 'game', 'level-design', 'level-code'],
      reason: 'fixture contract',
      assumptions: [],
    },
  });
  const candidates = [1, 2].map((i) => ({
    id: 'fixture-' + i,
    title: 'Synthetic reference ' + i,
    url: `https://fixture.invalid/${i}`,
    imageUrl: '',
    mechanics: 'fixture only',
    artDirection: 'fixture only',
  }));
  put('research-source', {
    id: id + '-source',
    projectId: p.id,
    results: candidates,
    dataSource: 'deterministic-test-fixture',
  });
  for (const attempt of [0, 1])
    put('model-result', {
      id: `${id}-0-${attempt}-research`,
      projectId: p.id,
      result: {
        summary: 'synthetic reference v' + attempt,
        candidates,
        sources: candidates.map((c) => c.url),
        recommendation: 'fixture',
      },
    });
  put('model-result', {
    id: `${id}-1-0-planner`,
    projectId: p.id,
    result: {
      title: 'Fixture GDD',
      summary: 'test only',
      controls: { move: 'arrows' },
      requirements: [1, 2, 3].map((i) => ({ id: 'r' + i, description: 'fixture', acceptance: 'fixture' })),
      entities: [],
      rules: [],
      artStyle: 'fixture',
      assets: [],
      audio: [],
      levelInterface: 'generateLevel / validateLevel fixture',
      difficulty: ['easy', 'normal', 'hard'],
      dimensions: { width: 960, height: 600 },
    },
  });
  assert.equal((await request(`/tasks/${id}/continue`, {})).status, 202);
  await waitForTask(id, 'review');
  assert.equal(list<any>('artifact', p.id).filter((a) => a.role === 'research').length, 1);
  const research = list<any>('artifact', p.id).find((a) => a.role === 'research');
  assert.ok(research.inputVersions.includes(id + '-plan'));
  assert.equal(research.inputVersions.includes(oldPlanId), false);
  let approval = list<any>('approval', p.id).at(-1);
  await stopServer();
  await startServer();
  assert.equal(get<any>('task', id).status, 'review');
  assert.equal((await request(`/tasks/${id}/continue`, {})).status, 400);
  assert.equal(
    (
      await request(`/approvals/${approval.id}`, {
        approved: true,
        feedback: '',
        selection: ['not-a-candidate'],
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(`/approvals/${approval.id}`, { approved: false, feedback: 'fixture revision required' }))
      .status,
    200,
  );
  for (let i = 0; i < 100 && list<any>('artifact', p.id).filter((a) => a.role === 'research').length < 2; i++)
    await new Promise((r) => setTimeout(r, 100));
  await waitForTask(id, 'review');
  assert.equal(list<any>('artifact', p.id).filter((a) => a.role === 'research').length, 2);
  assert.equal(
    (await request(`/approvals/${approval.id}`, { approved: true, feedback: '', selection: ['fixture-1'] }))
      .status,
    400,
  );
  approval = list<any>('approval', p.id).at(-1);
  assert.equal(
    (
      await request(`/approvals/${approval.id}`, {
        approved: true,
        feedback: 'fixture accepted',
        selection: ['fixture-1'],
      })
    ).status,
    200,
  );
  for (let i = 0; i < 100 && get<any>('task', id).stage !== 'planner'; i++)
    await new Promise((r) => setTimeout(r, 100));
  await waitForTask(id, 'review');
  const planner = list<any>('artifact', p.id).find((a) => a.role === 'planner');
  assert.ok(planner);
  assert.ok(planner.inputVersions.includes(`${id}-0-1-research`));
  assert.equal(list<any>('model-result', p.id).length, 4); // fully cached deterministic fixture; no model call
  await request(`/tasks/${id}/cancel`, {});
});
test('HTTP rejects foreign build telemetry and path escapes', async () => {
  const a = createProject('One', 'fixture'),
    b = createProject('Two', 'fixture');
  put('build', { id: 'foreign-build', projectId: a.id });
  const response = await request(`/projects/${b.id}/telemetry`, {
    buildId: 'foreign-build',
    sessionId: 's',
    source: 'script',
    seed: 1,
    difficulty: 'normal',
    kind: 'start',
    data: {},
  });
  assert.equal(response.status, 400);
  const r = await request(`/projects/${a.id}/files/assets/..%2F..%2F.env`);
  assert.ok(r.status >= 400);
});

test('approved ideation launches once with constraints, evidence and challenges in the production brief', async () => {
  const source = createProject('Ideation launch fixture', 'Synthetic source project');
  const artifactId = uid();
  put('artifact', {
    id: artifactId,
    projectId: source.id,
    role: 'ideation',
    version: 2,
    data: {
      title: 'Synthetic candidates',
      selected: 1,
      constraints: ['offline only', 'three difficulties'],
      candidates: [
        { title: 'Unused candidate', idea: 'unused fixture', evidence: [] },
        { title: 'Selected fixture', idea: 'Selected dodge mechanism', evidence: ['script sample; human=0'] },
      ],
      challenges: ['new collision contract needs verification'],
      rationale: 'testable deterministic generation',
    },
  });
  assert.equal((await request(`/projects/${source.id}/execute-ideation`, { artifactId })).status, 400);
  put('approval', { id: uid(), projectId: source.id, artifactId, status: 'approved' });
  const launched = await request(`/projects/${source.id}/execute-ideation`, { artifactId });
  assert.equal(launched.status, 201);
  const created = get<any>('project', launched.data.newProjectId);
  assert.equal(created.name, 'Selected fixture');
  for (const expected of [
    'offline only',
    'three difficulties',
    'human=0',
    'collision contract',
    'deterministic generation',
  ]) {
    assert.ok(created.idea.includes(expected));
  }
  const task = list<any>('task', created.id)[0];
  assert.equal(task.instruction, created.idea);
  assert.equal(task.kind, 'production');
  const origin = store.events(created.id).find((e) => e.kind === 'project-origin');
  assert.equal(origin?.data.artifactId, artifactId);
  assert.equal(origin?.data.artifactVersion, 2);
  const repeated = await request(`/projects/${source.id}/execute-ideation`, { artifactId });
  assert.equal(repeated.data.newProjectId, created.id);
  assert.equal(list<any>('task', created.id).length, 1);
  // Empty test credentials prevent cloud execution; retain only the handoff fixture.
  await request(`/tasks/${task.id}/cancel`, {});
});
