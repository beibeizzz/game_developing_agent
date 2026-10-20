// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import assert from 'node:assert/strict';
import test from 'node:test';
import {assert as assertBrowser, assertTelemetryV2, act} from '../../../src/game_developing_agent_mcp/local/templates/dodge/tests/002-telemetry.mjs';

function fixture() {
  const causes = {quit: 'beforeunload', restart: 'manual_restart', win: 'time_up', loss: 'hp_zero'};
  const collision = (id, applied, hp, session = 'round-1') => ({event: 'collision', obstacle_id: id, damage_applied: applied, hp, play_session_id: session});
  return {
    schemaVersion: 2,
    collisionDamage: 1,
    ends: Object.entries(causes).map(([outcome, cause]) => ({outcome, expectedHp: outcome === 'loss' ? 0 : 3, expectedActive: 120,
      rows: [{event: 'end', outcome, cause, hp: outcome === 'loss' ? 0 : 3, elapsed_active_ms: 120, elapsed_wall_ms: 620}]})),
    contact: {sessionId: 'round-1', immune: [collision(1, false, 3)], damaged: [collision(1, false, 3), collision(1, true, 2)], following: [collision(2, false, 2)]},
    restarted: {sessionId: 'round-2', rows: [collision(1, false, 3, 'round-2')]},
  };
}

test('browser assertion accepts v2 payload and per-session ID reset', async () => {
  await assertBrowser({evaluate: async () => fixture()});
});

test('older games retain the core test contract without requiring v2 fields', async () => {
  assertTelemetryV2({schemaVersion: undefined});
  assertTelemetryV2({schemaVersion: 1});
  const previous = globalThis.window;
  globalThis.window = {__phaserGame: {scene: {getScene: () => ({spec: {revisions: {game_rev: 4}}})}}};
  try {
    await act({evaluate: async callback => callback()});
    assert.deepEqual(globalThis.window.__telemetryRegression, {schemaVersion: undefined});
  } finally {
    globalThis.window = previous;
  }
});

for (const outcome of ['quit', 'restart', 'win', 'loss']) {
  for (const field of ['hp', 'cause', 'elapsed_active_ms', 'elapsed_wall_ms']) {
    test(outcome + ' requires accurate ' + field, () => {
      const snapshot = fixture();
      const row = snapshot.ends.find(item => item.outcome === outcome).rows[0];
      row[field] = field === 'cause' ? 'unknown' : -1;
      assert.throws(() => assertTelemetryV2(snapshot));
    });
  }
}

for (const [name, mutate] of [
  ['missing actual damage after immune contact', s => s.contact.damaged.pop()],
  ['repeated continuous immune contact', s => s.contact.immune.push({...s.contact.immune[0]})],
  ['changed obstacle ID at actual damage', s => s.contact.damaged[1].obstacle_id = 99],
  ['damage event without HP change', s => s.contact.damaged[1].hp = 3],
  ['non-increasing obstacle IDs', s => s.contact.following[0].obstacle_id = 1],
  ['reused session ID at restart', s => s.restarted.sessionId = 'round-1'],
  ['cross-session suppression of first collision', s => s.restarted.rows = []],
  ['duplicate quit end', s => s.ends[0].rows.push({...s.ends[0].rows[0]})],
]) {
  test('rejects ' + name, () => {
    const snapshot = fixture();
    mutate(snapshot);
    assert.throws(() => assertTelemetryV2(snapshot));
  });
}
