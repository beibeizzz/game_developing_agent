import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { verifyCoderResult } from '../src/coder-verification.js';

const claimed = {
  subtype: 'success',
  is_error: false,
  structured_output: { testsPassed: true, files: ['game.mjs'] },
};
function workspace() {
  mkdirSync('.local/tests', { recursive: true });
  return mkdtempSync(resolve('.local/tests/verification-'));
}
function fixtures(root: string, testCommand: string, buildCommand: string) {
  for (const name of ['game.mjs', 'game.test.mjs', 'game-config.json', 'GAME_INTERFACE.md'])
    writeFileSync(join(root, name), '');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, scripts: { test: testCommand, build: buildCommand } }),
  );
}
test('SDK success with absent source or a fabricated file cannot complete a job', () => {
  const root = workspace();
  assert.throws(() => verifyCoderResult('game', claimed, root), /交付文件/);
  fixtures(root, 'node --version', 'node --version');
  assert.throws(
    () =>
      verifyCoderResult(
        'game',
        { ...claimed, structured_output: { testsPassed: true, files: ['invented.mjs'] } },
        root,
      ),
    /invented/,
  );
});
test('real failing test command overrides model testsPassed=true', () => {
  const root = workspace();
  fixtures(root, 'node failing.mjs', 'node --version');
  writeFileSync(join(root, 'failing.mjs'), 'process.exit(7);');
  assert.throws(
    () => verifyCoderResult('game', claimed, root),
    (e: any) => e.status === 7,
  );
});
test('a successful command without the actual browser build is rejected', () => {
  const root = workspace();
  fixtures(root, 'node --version', 'node --version');
  assert.throws(() => verifyCoderResult('game', claimed, root), /构建缺少/);
});
