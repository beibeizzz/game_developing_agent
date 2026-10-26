import { mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
const root = resolve('.'),
  output = resolve(root, 'dist');
if (dirname(output) !== root) throw new Error('Build output must be inside the game workspace');
rmSync(output, { recursive: true, force: true });
mkdirSync('dist', { recursive: true });
for (const file of readdirSync('.')) {
  if (
    /\.(mjs|json|html|css)$/.test(file) &&
    !/\.test\.mjs$/.test(file) &&
    !['build.mjs', 'serve.mjs', 'package.json', 'contract.json', 'package-lock.json'].includes(file)
  )
    cpSync(file, 'dist/' + file);
}
const manifest = JSON.parse(readFileSync('asset-manifest.json', 'utf8'));
for (const asset of [...manifest.images, ...manifest.audio]) {
  if (!/^assets\/[\w.-]+$/.test(asset.file)) throw new Error('Invalid asset path: ' + asset.file);
  mkdirSync('dist/assets', { recursive: true });
  cpSync(asset.file, 'dist/' + asset.file);
}
writeFileSync('dist/BUILD.json', JSON.stringify({ at: new Date().toISOString(), offline: true }));
console.log('Built independent local browser game in dist/');
