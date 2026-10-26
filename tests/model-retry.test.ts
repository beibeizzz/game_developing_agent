import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
mkdirSync('.local/tests', { recursive: true });
process.env.AGENT_DATA_DIR = mkdtempSync(resolve('.local/tests/model-retry-'));
process.env.ARK_AGENT_PLAN_API_KEY = 'synthetic-test-token';
const { modelRole } = await import('../src/model.js');
const { createProject, uid, events, db } = await import('../src/store.js');
const { projectReport } = await import('../src/reporting.js');
const { put } = await import('../src/store.js');
const { schemas } = await import('../src/contracts.js');
const schema = z.object({ summary: z.string() });
function task() {
  const project = createProject('Synthetic retry fixture', 'No real model call');
  return put('task', {
    id: uid(),
    projectId: project.id,
    instruction: 'Synthetic verification',
    kind: 'production',
    status: 'running',
    stage: 'planner',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as any;
}
const nativeFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});
test.after(() => db.close());

test('one text timeout retries identical context and records attempts separately from responses', async () => {
  const t = task();
  const bodies: string[] = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(String(options?.body));
    if (bodies.length === 1) throw new DOMException('Synthetic timeout', 'TimeoutError');
    return new Response(
      JSON.stringify({
        id: 'synthetic-response',
        model: 'synthetic',
        usage: { total_tokens: 1 },
        choices: [
          { finish_reason: 'stop', message: { role: 'assistant', content: '{"summary":"fixture"}' } },
        ],
      }),
    );
  };
  assert.deepEqual(await modelRole(t, 'planner', 'Synthetic test only', {}, schema), { summary: 'fixture' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(events(t.projectId).filter((e) => e.kind === 'model-retry').length, 1);
  const report = projectReport(t.projectId).tasks[0];
  assert.equal(report.modelAttempts, 2);
  assert.equal(report.modelRequests, 1);
});

test('consecutive text timeouts stop after two attempts', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new DOMException('Synthetic timeout', 'TimeoutError');
  };
  await assert.rejects(modelRole(task(), 'planner', 'Synthetic', {}, schema), /Synthetic timeout/);
  assert.equal(calls, 2);
});

test('punctuation-only expert fields trigger correction while empty lists remain valid', async () => {
  const t = task();
  const valid = {
    summary: '合成测试：本批只有脚本证据',
    observations: ['Seed 1024'],
    evidence: ['fixture-evaluation'],
    hypothesis: '体验需要人工样本',
    changes: [],
    risks: [],
    questions: [],
  };
  for (const field of ['observations', 'evidence', 'risks', 'questions']) {
    assert.equal(schemas.expert.safeParse({ ...valid, [field]: [' .… '] }).success, false);
  }
  assert.equal(schemas.expert.safeParse({ ...valid, changes: [{ file: '.', change: '.' }] }).success, false);
  const bodies: any[] = [];
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    const value = bodies.length === 1 ? { ...valid, evidence: ['.'] } : valid;
    return new Response(
      JSON.stringify({
        id: 'fixture-expert-' + bodies.length,
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
      }),
    );
  };
  assert.deepEqual(await modelRole(t, 'gd', 'Synthetic test only', {}, schemas.expert), valid);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].messages.at(-1).content, /单个标点占位无效/);
  assert.equal(events(t.projectId).filter((e) => e.kind === 'model-output-invalid').length, 1);
});

test('task cancellation and HTTP errors are not automatically retried', async () => {
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    controller.abort();
    throw new DOMException('Synthetic timeout', 'TimeoutError');
  };
  await assert.rejects(modelRole(task(), 'planner', 'Synthetic', {}, schema, [], controller.signal));
  assert.equal(calls, 1);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('Synthetic denied', { status: 403 });
  };
  await assert.rejects(modelRole(task(), 'planner', 'Synthetic', {}, schema), /403/);
  assert.equal(calls, 1);
});
