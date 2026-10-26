import { posix } from 'node:path';

const immutable = new Set([
  'shell.mjs',
  'shell.css',
  'index.html',
  'build.mjs',
  'serve.mjs',
  'package.json',
  'blueprint.html',
  'contract.json',
  'asset-manifest.json',
]);
export const toolRestriction =
  '在 /work 使用文件工具；Bash 支持 npm test、npm run build、node --test、ls 和 pwd。固化壳文件由宿主管理。';

export function allowedCoderTool(name: string, args: Record<string, unknown>): boolean {
  if (name === 'StructuredOutput') return true;
  if (['Read', 'Write', 'Edit'].includes(name)) {
    const file = posix.resolve('/work', String(args.file_path || ''));
    return file.startsWith('/work/') && (name === 'Read' || !immutable.has(file.slice(6)));
  }
  if (['Glob', 'Grep'].includes(name)) {
    const path = posix.resolve('/work', String(args.path || '.'));
    const pattern = String(args.pattern || '');
    return (
      (path === '/work' || path.startsWith('/work/')) &&
      (name !== 'Glob' || (!pattern.startsWith('/') && !pattern.split('/').includes('..')))
    );
  }
  if (name === 'Bash') {
    const command = String(args.command || '').trim();
    if (/^(npm test|npm run build|pwd)$/.test(command)) return true;
    if (!/^(node --test(?: [\w.*\/-]+)?|ls(?: [\w.*\/-]+)?)$/.test(command)) return false;
    return command
      .split(' ')
      .slice(name === 'Bash' && command.startsWith('node') ? 2 : 1)
      .every((arg) => {
        const path = posix.resolve('/work', arg);
        return path === '/work' || path.startsWith('/work/');
      });
  }
  return false;
}
