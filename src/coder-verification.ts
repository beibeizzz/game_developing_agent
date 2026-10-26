import { existsSync, statSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Verify the files and commands independently of the model's success claim. */
export function verifyCoderResult(role: string, result: any, workspace: string) {
  if (result?.subtype !== 'success' || result.is_error || !result.structured_output?.testsPassed)
    throw new Error(`编码结果：${result?.subtype || 'missing result'}`);
  const root = resolve(workspace);
  const required =
    role === 'game'
      ? ['game.mjs', 'game.test.mjs', 'game-config.json', 'GAME_INTERFACE.md']
      : ['level.mjs', 'level.test.mjs', 'LEVEL_INTERFACE.md'];
  for (const name of [...required, ...(result.structured_output.files || [])]) {
    const path = resolve(root, name);
    if (!path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile())
      throw new Error('缺少或无效交付文件：' + name);
  }
  const npmCli = process.env.npm_execpath;
  const run = (args: string[]) =>
    execFileSync(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 120000,
    });
  const testOutput = run(['test']);
  const buildOutput = run(['run', 'build']);
  if (!existsSync(join(root, 'dist/index.html'))) throw new Error('构建缺少 index.html');
  return { testOutput, buildOutput };
}
