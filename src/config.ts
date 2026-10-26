import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(process.env.AGENT_ENV_FILE || '.env');
if (existsSync(envFile))
  for (const line of readFileSync(envFile, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined)
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
export const config = {
  root: resolve('.'),
  data: resolve(process.env.AGENT_DATA_DIR || '.local/workbench'),
  port: Number(process.env.PORT || 8787),
  previewPort: Number(process.env.PREVIEW_PORT || 8788),
  token: process.env.ARK_AGENT_PLAN_API_KEY || '',
  model: process.env.ARK_TEXT_MODEL || 'ark-code-latest',
  imageModel: process.env.ARK_IMAGE_MODEL || 'doubao-seedream-5-0-pro',
  textBase: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  anthropicBase: 'https://ark.cn-beijing.volces.com/api/plan',
  image: process.env.CODER_IMAGE || 'game-developing-agent-coder:local',
  maxTurns: Number(process.env.CODER_MAX_TURNS || 40),
  toolRounds: Number(process.env.AGENT_TOOL_ROUNDS || 12),
  coderTimeoutMs: Number(process.env.CODER_TIMEOUT_MINUTES || 30) * 60_000,
};
mkdirSync(config.data, { recursive: true });
export const redact = (text: string) => (config.token ? text.split(config.token).join('[REDACTED]') : text);
export const now = () => new Date().toISOString();
