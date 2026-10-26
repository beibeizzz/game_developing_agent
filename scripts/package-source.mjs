import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

const root = resolve('.');
const roots = [
  'src',
  'ui',
  'templates',
  'prompts',
  'tests',
  'scripts',
  'dist/workbench',
  'README.md',
  'LICENSE',
  'NOTICE',
  'AGENTS.md',
  'agent.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'playwright.config.ts',
  '.prettierrc.json',
  '.prettierignore',
  'Dockerfile.coder',
  '.dockerignore',
  '.gitignore',
  '.env.example',
];
const entries = {};
const secrets = [process.env.ARK_AGENT_PLAN_API_KEY || ''];
if (existsSync('.env'))
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const match = line.match(/^ARK_AGENT_PLAN_API_KEY\s*=\s*['"]?([^'"\s]+)['"]?\s*$/);
    if (match) secrets.push(match[1]);
  }
function walk(path) {
  for (const item of readdirSync(path, { withFileTypes: true })) {
    if (
      item.isSymbolicLink() ||
      ['node_modules', '.local', '__pycache__', '.git', 'test-results', 'playwright-report'].includes(
        item.name,
      )
    )
      continue;
    const child = join(path, item.name);
    if (item.isDirectory()) walk(child);
    else add(child);
  }
}
function add(path) {
  const name = relative(root, path).replaceAll('\\', '/');
  if (/(^|\/)\.env($|\.)/.test(name) && name !== '.env.example') return;
  if (/\.(pyc|sqlite|sqlite-wal|sqlite-shm|log)$/.test(name)) return;
  const data = readFileSync(path);
  if (secrets.some((secret) => secret.length > 8 && data.includes(Buffer.from(secret))))
    throw new Error('Credential found in package input: ' + name);
  entries['game_developing_agent/' + name] = data;
}
for (const name of roots) {
  const path = resolve(root, name);
  if (!existsSync(path)) continue;
  if (readdirSync(root, { withFileTypes: true }).some((x) => x.name === name && x.isFile())) add(path);
  else if (/\.[a-z]+$/i.test(name) && name !== 'dist/workbench') add(path);
  else walk(path);
}
let notices = 'Bundled workbench third-party notices\n\n';
for (const name of ['react', 'react-dom', 'scheduler']) {
  const file = join(root, 'node_modules', name, 'LICENSE');
  if (existsSync(file)) notices += `--- ${name} ---\n${readFileSync(file, 'utf8')}\n`;
}
entries['game_developing_agent/THIRD_PARTY_NOTICES.txt'] = Buffer.from(notices);
const archive = zipSync(entries, { level: 6 });
const output = resolve(root, 'dist/releases');
mkdirSync(output, { recursive: true });
const file = join(output, 'game_developing_agent-0.1.0-source.zip');
writeFileSync(file, archive);
const manifest = {
  file: relative(root, file),
  sha256: createHash('sha256').update(archive).digest('hex'),
  bytes: archive.length,
  files: Object.keys(entries).sort(),
  createdAt: new Date().toISOString(),
};
writeFileSync(join(output, 'source-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(
  JSON.stringify({
    file: manifest.file,
    sha256: manifest.sha256,
    bytes: manifest.bytes,
    fileCount: manifest.files.length,
  }),
);
