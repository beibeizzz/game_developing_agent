import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { config, now } from './config.js';
import { docker } from './coder.js';
import { event, get, list, put, projectDir } from './store.js';
import type { Task } from './contracts.js';

export function zipDirectory(root: string, excluded = new Set(['node_modules', '.git', '.env'])) {
  const entries: Record<string, Uint8Array> = {};
  function walk(dir: string) {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (excluded.has(item.name) || item.isSymbolicLink()) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else entries[relative(root, path).replaceAll('\\', '/')] = readFileSync(path);
    }
  }
  walk(root);
  return zipSync(entries, { level: 6 });
}
export async function deliver(task: Task, id: string, signal: AbortSignal) {
  const existing = get('build', id);
  if (existing) return existing;
  signal.throwIfAborted();
  const workspace = projectDir(task.projectId, 'workspaces', 'game');
  const check = await docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--memory',
      '2g',
      '--cpus',
      '2',
      '--mount',
      `type=bind,src=${workspace},dst=/work`,
      '-w',
      '/work',
      config.image,
      'timeout',
      '--kill-after=5s',
      '120s',
      'sh',
      '-c',
      'npm test && npm run build',
    ],
    { timeout: 180000 },
  );
  signal.throwIfAborted();
  const dist = join(workspace, 'dist');
  for (const f of ['index.html', 'game.mjs', 'level.mjs', 'game-config.json', 'asset-manifest.json'])
    if (!existsSync(join(dist, f))) throw new Error('交付缺少 ' + f);
  const levelSource = readFileSync(join(dist, 'level.mjs'), 'utf8');
  if (/version\s*:\s*['"]bootstrap['"]/.test(levelSource)) throw new Error('关卡生成器仍为 bootstrap');
  if (existsSync(join(dist, 'contract.json'))) throw new Error('构建包含内部执行上下文，请更新构建壳');
  const manifest = JSON.parse(readFileSync(join(dist, 'asset-manifest.json'), 'utf8'));
  const assetFiles = new Set<string>([...manifest.images, ...manifest.audio].map((a) => a.file));
  const assets = list<any>('asset', task.projectId).filter((a) => assetFiles.has(a.file));
  if ([...assetFiles].some((file) => !assets.some((a) => a.file === file)))
    throw new Error('交付资产缺少生成或授权来源');
  const buildRoot = projectDir(task.projectId, 'builds', id);
  mkdirSync(buildRoot, { recursive: true });
  cpSync(dist, join(buildRoot, 'web'), { recursive: true });
  cpSync(workspace, join(buildRoot, 'source'), {
    recursive: true,
    filter: (path) => {
      const name = relative(workspace, path).replaceAll('\\', '/');
      return (
        !/^(node_modules|dist|\.git)(\/|$)/.test(name) &&
        !name.startsWith('.env') &&
        name !== 'contract.json' &&
        (!name.startsWith('assets/') || assetFiles.has(name))
      );
    },
  });
  const provenance = {
    assets: assets.map((a) => ({
      file: a.file,
      source: a.source,
      parameters: a.parameters,
      generatedAt: a.at,
    })),
    note: 'Research screenshots are design references and are excluded. Generated visuals use the configured provider; audio synthesis parameters are retained.',
  };
  for (const folder of ['source', 'web'])
    writeFileSync(join(buildRoot, folder, 'ASSET_PROVENANCE.json'), JSON.stringify(provenance, null, 2));
  writeFileSync(join(buildRoot, 'source.zip'), zipDirectory(join(buildRoot, 'source')));
  writeFileSync(join(buildRoot, 'web.zip'), zipDirectory(join(buildRoot, 'web')));
  writeFileSync(join(buildRoot, 'validation.txt'), check.stdout + check.stderr);
  const value = put('build', {
    id,
    projectId: task.projectId,
    taskId: task.id,
    at: now(),
    sourceSha256: createHash('sha256')
      .update(readFileSync(join(buildRoot, 'source.zip')))
      .digest('hex'),
    webSha256: createHash('sha256')
      .update(readFileSync(join(buildRoot, 'web.zip')))
      .digest('hex'),
    tests: check.stdout,
    status: 'review',
    preview: `http://127.0.0.1:${config.previewPort}/play/${task.projectId}/${id}/index.html`,
  });
  event(task.projectId, task.id, 'build', value);
  return value;
}
