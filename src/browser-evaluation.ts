import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, now } from './config.js';
import { event, list, projectDir, put, required, taskUpdate, uid } from './store.js';
import type { Task, Telemetry } from './contracts.js';

export async function runBrowserEvaluation(task: Task, signal: AbortSignal) {
  const build = list<any>('build', task.projectId).at(-1);
  if (!build) throw new Error('请先完成游戏构建');
  const attempt =
    list<any>('evaluation', task.projectId).filter((e) => e.taskId === task.id || e.id === task.id).length +
    1;
  const evaluationId = `${task.id}-attempt-${attempt}`;
  const root = projectDir(task.projectId, 'evaluations', evaluationId);
  mkdirSync(root, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const stop = () => {
    void browser.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  const checks: any[] = [],
    errors: string[] = [],
    external: string[] = [];
  let records: any[] = [];
  let measurementSession = '';
  let referenceLevel: any;
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
    const origin = `http://127.0.0.1:${config.previewPort}`;
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      external.push(url.href);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.goto(build.preview + `?project=${task.projectId}&build=${build.id}&source=script`);
    await page.waitForFunction(() => !!(window as any).__game);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const state = () => page.evaluate(() => (window as any).__game.getState());
    const start = async (difficulty = 'normal', seed = 1024) => {
      await page.locator('#difficulty').selectOption(difficulty);
      await page.locator('#seed').fill(String(seed));
      await page.locator('#start').click();
      await page.clock.runFor(32);
      const value = await state();
      assert.equal(value.started, true, (await page.locator('#error').textContent()) || '游戏未启动');
      return value;
    };
    const check = async (id: string, title: string, action: () => Promise<any>) => {
      signal.throwIfAborted();
      taskUpdate(task.id, { stage: 'evaluation:' + id });
      try {
        const evidence = await action();
        checks.push({ id, title, passed: true, evidence });
      } catch (error) {
        checks.push({ id, title, passed: false, error: String(error) });
      }
      event(task.projectId, task.id, 'evaluation-check', checks.at(-1));
    };
    await check('start', '游戏可启动，实际图片音频已加载', async () => {
      const s = await start();
      return { started: s.started, levelWaves: s.level.waves.length };
    });
    await check('wasd', 'WASD 实际移动', async () => {
      await start();
      const before = await state();
      await page.keyboard.down('d');
      await page.clock.runFor(240);
      await page.keyboard.up('d');
      const after = await state();
      assert.ok(after.state.player.x > before.state.player.x + 1);
      return { before: before.state.player, after: after.state.player };
    });
    await check('arrows', '方向键实际移动', async () => {
      await start();
      const before = await state();
      await page.keyboard.down('ArrowLeft');
      await page.clock.runFor(240);
      await page.keyboard.up('ArrowLeft');
      const after = await state();
      assert.ok(after.state.player.x < before.state.player.x - 1);
      return { before: before.state.player, after: after.state.player };
    });
    await check('diagonal', '对角线与直线移动速度一致', async () => {
      const speeds = [];
      for (const keys of [['d'], ['d', 'w']]) {
        const before = await start('easy');
        for (const key of keys) await page.keyboard.down(key);
        await page.clock.runFor(800);
        for (const key of keys) await page.keyboard.up(key);
        const after = await state();
        const distance = Math.hypot(
          after.state.player.x - before.state.player.x,
          after.state.player.y - before.state.player.y,
        );
        speeds.push(distance / (after.elapsed - before.elapsed));
      }
      assert.ok(speeds[0] > 0);
      assert.ok(Math.abs(speeds[1] / speeds[0] - 1) < 0.01);
      return { straightSpeed: speeds[0], diagonalSpeed: speeds[1] };
    });
    await check('pause', 'P 暂停冻结游戏状态，继续后恢复推进', async () => {
      await start();
      await page.keyboard.press('p');
      const before = await state();
      await page.clock.runFor(1000);
      const frozen = await state();
      assert.equal(frozen.paused, true);
      assert.equal(frozen.elapsed, before.elapsed);
      assert.deepEqual(frozen.state, before.state);
      await page.keyboard.press('p');
      await page.clock.runFor(100);
      const resumed = await state();
      assert.equal(resumed.paused, false);
      assert.ok(resumed.elapsed > frozen.elapsed);
      return { before: before.elapsed, frozen: frozen.elapsed, resumed: resumed.elapsed };
    });
    await check('restart', 'R 重开重置时钟和玩家', async () => {
      const initial = await start();
      await page.keyboard.down('d');
      await page.clock.runFor(300);
      await page.keyboard.up('d');
      await page.keyboard.press('r');
      await page.clock.runFor(32);
      const s = await state();
      assert.ok(s.elapsed < 0.1);
      assert.equal(s.state.player.x, initial.state.player.x);
      assert.equal(s.state.player.y, initial.state.player.y);
      await page.keyboard.press('p');
      await page.keyboard.press('r');
      await page.clock.runFor(32);
      const restartedFromPause = await state();
      assert.equal(restartedFromPause.paused, false);
      assert.ok(restartedFromPause.elapsed < 0.1);
      assert.equal(restartedFromPause.difficulty, initial.difficulty);
      assert.equal(restartedFromPause.seed, initial.seed);
      return { elapsed: s.elapsed, player: s.state.player };
    });
    await check('boundary', '玩家保留半径并限制在画布内', async () => {
      await start('easy');
      await page.keyboard.down('ArrowLeft');
      await page.clock.runFor(2500);
      await page.keyboard.up('ArrowLeft');
      const s = await state();
      assert.ok(s.state.player.x >= s.state.player.radius);
      assert.ok(s.state.player.x <= s.level.width - s.state.player.radius);
      return s.state.player;
    });
    await check('seed', '同参数与 Seed 复现，改变 Seed 改变关卡', async () => {
      const a = (await start()).level;
      const b = (await start()).level;
      const c = (await start('normal', 1025)).level;
      assert.deepEqual(a, b);
      assert.notDeepEqual(a.waves, c.waves);
      return { seed: a.seed, waveCount: a.waves.length, changedSeed: c.seed };
    });
    await check('difficulty', '三种难度产生不同关卡参数', async () => {
      const results = [];
      for (const difficulty of ['easy', 'normal', 'hard']) {
        const s = await start(difficulty);
        results.push({ difficulty: s.difficulty, waves: s.level.waves });
      }
      assert.notDeepEqual(results[0].waves, results[1].waves);
      assert.notDeepEqual(results[1].waves, results[2].waves);
      return results.map((r) => ({ difficulty: r.difficulty, waveCount: r.waves.length }));
    });
    await check('complete-round', '脚本输入完成一局并保存真实结束事件', async () => {
      const s = await start('normal');
      referenceLevel = s.level;
      await page.screenshot({ path: join(root, 'game.png') });
      measurementSession = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('game-agent-telemetry') || '[]').findLast(
            (e: any) => e.kind === 'start',
          )?.sessionId || '',
      );
      const max = Math.min(180, Math.max(35, s.level.duration + 5));
      for (let t = 0; t < max; t += 2) {
        await page.clock.runFor(2000);
        if ((await state()).ended) break;
      }
      const last = await state();
      assert.equal(last.ended, true);
      const endings = await page.evaluate(
        (session) =>
          JSON.parse(localStorage.getItem('game-agent-telemetry') || '[]').filter(
            (e: any) => e.sessionId === session && ['game_over', 'win'].includes(e.kind),
          ),
        measurementSession,
      );
      assert.equal(endings.length, 1);
      assert.ok(Number.isFinite(endings[0].data.survivalSeconds));
      if (endings[0].kind === 'win') assert.ok(last.elapsed >= s.level.duration);
      return { elapsed: last.elapsed, state: last.state, strategy: 'stationary baseline, scripted input' };
    });
    await check('restart-after-end', '结束后 R 可立即开始新一局', async () => {
      assert.equal((await state()).ended, true);
      await page.keyboard.press('r');
      await page.clock.runFor(32);
      const s = await state();
      assert.equal(s.started, true);
      assert.equal(s.ended, false);
      assert.ok(s.elapsed < 0.1);
      return { elapsed: s.elapsed, seed: s.seed, difficulty: s.difficulty };
    });
    await check('offline', '外网请求被阻止时独立运行，无脚本错误', async () => {
      assert.deepEqual(external, []);
      assert.deepEqual(errors, []);
      return { blockedExternalRequests: external, pageErrors: errors };
    });
    records = await page.evaluate(() => JSON.parse(localStorage.getItem('game-agent-telemetry') || '[]'));
    await check('blueprint', '蓝图页面读取同一生成器并通过验证', async () => {
      await page.goto(build.preview.replace('index.html', 'blueprint.html'), { waitUntil: 'networkidle' });
      const report = JSON.parse((await page.locator('#report').textContent()) || '{}');
      assert.equal(report.validation.valid, true);
      assert.ok(report.waves > 0);
      assert.deepEqual(await page.evaluate(() => (window as any).__blueprint), referenceLevel);
      await page.screenshot({ path: join(root, 'blueprint.png') });
      return report;
    });
    await check('resource-error', '素材加载失败会显示具体资源 ID', async () => {
      const broken = await context.newPage();
      try {
        await broken.clock.resume();
        await broken.route('**/assets/*.png', (route) => route.abort());
        await broken.goto(build.preview, { waitUntil: 'networkidle' });
        const error = await broken.locator('#error').textContent();
        assert.match(error || '', /图片加载失败：.+\(/);
        await broken.screenshot({ path: join(root, 'missing-resource.png') });
        return { error, injection: 'PNG requests blocked in isolated browser page' };
      } finally {
        await broken.close();
      }
    });
  } catch (error) {
    signal.throwIfAborted();
    checks.push({
      id: 'browser-execution',
      title: '浏览器环境和页面可执行',
      passed: false,
      error: String(error),
    });
  } finally {
    signal.removeEventListener('abort', stop);
    await browser.close();
  }
  signal.throwIfAborted();
  writeFileSync(join(root, 'regression-events.json'), JSON.stringify(records, null, 2));
  for (const record of records)
    if (
      record.sessionId === measurementSession &&
      record.buildId === build.id &&
      record.projectId === task.projectId
    )
      put<Telemetry>('telemetry', {
        id: uid(),
        projectId: task.projectId,
        buildId: build.id,
        source: 'script',
        sessionId: evaluationId + '-' + record.sessionId,
        seed: record.seed,
        difficulty: record.difficulty,
        kind: record.kind,
        data: record.data,
        at: now(),
      });
  const report = {
    id: evaluationId,
    taskId: task.id,
    attempt,
    projectId: task.projectId,
    buildId: build.id,
    source: 'script',
    seed: 1024,
    difficulty: 'normal',
    passed: checks.filter((c) => c.passed).length,
    total: checks.length,
    checks,
    at: now(),
    external,
    errors,
    strategy:
      'keyboard regression plus one stationary baseline round; only the baseline session enters survival metrics',
    screenshot: `evaluations/${evaluationId}/game.png`,
  };
  put('evaluation', report);
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
  taskUpdate(task.id, {
    status: checks.every((c) => c.passed) ? 'completed' : 'failed',
    stage: 'evaluation-complete',
    error: checks.every((c) => c.passed) ? undefined : '部分行为回归失败，请查看测评报告。',
  });
  event(task.projectId, task.id, 'evaluation', report);
  return report;
}
