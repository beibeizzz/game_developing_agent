import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedCoderTool } from '../src/coder-policy.js';

test('coding policy protects fixed shell and confines tool paths', () => {
  assert.equal(allowedCoderTool('Write', { file_path: '/work/game.mjs' }), true);
  assert.equal(allowedCoderTool('Edit', { file_path: '/work/sub/../shell.mjs' }), false);
  assert.equal(allowedCoderTool('Read', { file_path: '/state/session.json' }), false);
  assert.equal(allowedCoderTool('Glob', { pattern: '/state/*' }), false);
  assert.equal(allowedCoderTool('Glob', { pattern: '../*' }), false);
  assert.equal(allowedCoderTool('Glob', { pattern: '**/*.mjs' }), true);
  assert.equal(allowedCoderTool('StructuredOutput', {}), true);
});

test('coding policy denies compound read-only Bash calls and out-of-workspace arguments', () => {
  for (const command of [
    'ls /work/assets; ls /work | grep -i game',
    'ls /state',
    'node --test /state/test.mjs',
    'node --test ../test.mjs',
  ])
    assert.equal(allowedCoderTool('Bash', { command }), false, command);
  for (const command of ['npm test', 'npm run build', 'node --test game.test.mjs', 'ls /work/assets', 'pwd'])
    assert.equal(allowedCoderTool('Bash', { command }), true, command);
});
