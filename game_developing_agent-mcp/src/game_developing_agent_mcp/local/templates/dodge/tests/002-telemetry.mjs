// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import check from 'node:assert/strict';

export const name = 'development telemetry schema v2';
export const tags = ['regression', 'telemetry'];
export const covers = ['src/scene.js', 'src/telemetry.js', 'game-spec.json'];

const causes = {quit: 'beforeunload', restart: 'manual_restart', win: 'time_up', loss: 'hp_zero'};
const ordinal = value => {
  check.ok(typeof value === 'string' || Number.isInteger(value), 'obstacle ID is present');
  const match = String(value).match(/(\d+)$/);
  check.ok(match, 'obstacle ID has an increasing ordinal');
  return Number(match[1]);
};

export function assertTelemetryV2(snapshot) {
  // Earlier games retain their existing core gameplay test contract.
  if (snapshot.schemaVersion !== 2) return;
  check.deepEqual(snapshot.ends.map(item => item.outcome).sort(), Object.keys(causes).sort());
  for (const {outcome, rows, expectedHp, expectedActive} of snapshot.ends) {
    check.equal(rows.length, 1, outcome + ' emits one end');
    const row = rows[0];
    check.equal(row.event, 'end');
    check.equal(row.outcome, outcome);
    check.equal(row.cause, causes[outcome], outcome + ' cause');
    check.equal(row.hp, expectedHp, outcome + ' current HP');
    check.equal(row.elapsed_active_ms, Math.round(expectedActive), outcome + ' active clock');
    check.ok(Number.isInteger(row.elapsed_wall_ms) && row.elapsed_wall_ms >= row.elapsed_active_ms,
      outcome + ' wall clock includes active time');
    check.ok(row.elapsed_active_ms > 0, outcome + ' retains elapsed time');
  }
  const {immune, damaged, following, sessionId} = snapshot.contact;
  check.equal(immune.length, 1, 'continuous immune contact emits once');
  check.deepEqual(damaged.map(row => row.damage_applied), [false, true], 'later damage emits after immune contact');
  check.equal(damaged[0].obstacle_id, damaged[1].obstacle_id, 'same obstacle survives immune contact');
  check.equal(immune[0].obstacle_id, damaged[0].obstacle_id);
  check.equal(damaged[1].hp, damaged[0].hp - snapshot.collisionDamage, 'actual HP decreases');
  for (const row of damaged) check.equal(row.play_session_id, sessionId);
  check.equal(following.length, 1, 'next obstacle emits separately');
  check.ok(ordinal(following[0].obstacle_id) > ordinal(damaged[0].obstacle_id), 'IDs increase within a round');
  check.notEqual(snapshot.restarted.sessionId, sessionId, 'restart begins a distinct play session');
  check.equal(snapshot.restarted.rows.length, 1, 'new round contact has its own record');
  check.equal(snapshot.restarted.rows[0].play_session_id, snapshot.restarted.sessionId);
  check.equal(snapshot.restarted.rows[0].damage_applied, false);
  ordinal(snapshot.restarted.rows[0].obstacle_id);
}

export async function setup(page) {
  await page.waitForFunction(() => window.__phaserGame?.scene.getScene('MeteorScene')?.state === 'ready');
}

export async function act(page) {
  await page.evaluate(() => {
    const s = window.__phaserGame.scene.getScene('MeteorScene');
    const snapshot = {schemaVersion: s.spec.telemetry_schema_version};
    window.__telemetryRegression = snapshot;
    if (snapshot.schemaVersion !== 2) return;
    snapshot.ends = [];
    snapshot.collisionDamage = s.spec.round.collision_damage;
    // Each fixture seeds positions/time; the production update and UI handlers emit all rows.
    const begin = () => {
      document.querySelector('#restart').click();
      s.nextSpawn = s.plan.spawns.length;
      s.obstacles.clear(true, true);
      s.activeMs = 100;
      s.telemetry.started = performance.now() - 600;
    };
    const tick = delta => {
      s.telemetry.started = performance.now() - s.activeMs - delta - 500;
      s.update(0, delta);
    };
    const collide = () => {
      s.spawn({x: s.player.x, radius_px: 24, speed_px_s: 0});
      s.obstacles.getChildren().at(-1).y = s.player.y;
    };
    const endRows = from => s.telemetry.rows.slice(from).filter(row => row.event === 'end');
    const captureEnd = (outcome, action) => {
      const from = s.telemetry.rows.length;
      const expectedHp = s.hp;
      const expectedActive = s.activeMs;
      action();
      snapshot.ends.push({outcome, rows: endRows(from), expectedHp, expectedActive});
    };
    begin();
    s.hp -= s.spec.round.collision_damage;
    captureEnd('quit', () => window.dispatchEvent(new Event('beforeunload')));
    begin();
    s.hp -= s.spec.round.collision_damage;
    captureEnd('restart', () => document.querySelector('#restart').click());
    begin();
    s.hp -= s.spec.round.collision_damage;
    s.activeMs = s.spec.round.duration_ms - 16;
    const winFrom = s.telemetry.rows.length;
    tick(16);
    snapshot.ends.push({outcome: 'win', rows: endRows(winFrom), expectedHp: s.hp, expectedActive: s.activeMs});
    begin();
    s.hp = s.spec.round.collision_damage;
    s.invulnerableUntil = 0;
    collide();
    const lossFrom = s.telemetry.rows.length;
    tick(16);
    snapshot.ends.push({outcome: 'loss', rows: endRows(lossFrom), expectedHp: 0, expectedActive: s.activeMs});
    begin();
    const from = s.telemetry.rows.length;
    const sessionId = s.telemetry.id;
    const collisions = start => s.telemetry.rows.slice(start).filter(row => row.event === 'collision');
    s.invulnerableUntil = s.activeMs + s.spec.round.invulnerability_ms;
    collide();
    tick(16); tick(16); tick(16);
    const immune = collisions(from);
    s.activeMs = s.invulnerableUntil;
    tick(16);
    const damaged = collisions(from);
    const followingFrom = s.telemetry.rows.length;
    collide();
    tick(16);
    snapshot.contact = {sessionId, immune, damaged, following: collisions(followingFrom)};
    begin();
    const restartedFrom = s.telemetry.rows.length;
    s.invulnerableUntil = s.activeMs + s.spec.round.invulnerability_ms;
    collide();
    tick(16); tick(16);
    snapshot.restarted = {sessionId: s.telemetry.id, rows: collisions(restartedFrom)};
  });
}

export async function assert(page) {
  assertTelemetryV2(await page.evaluate(() => window.__telemetryRegression));
}
