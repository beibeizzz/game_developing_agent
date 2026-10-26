import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, now, redact } from './config.js';
import { event, get, put, projectDir, uid } from './store.js';
import type { Job, Task } from './contracts.js';
import { contextFor } from './memory.js';

const execute = promisify(execFile);
function syncLevel(task: Task) {
  for (const file of ['level.mjs', 'level.test.mjs', 'LEVEL_INTERFACE.md'])
    cpSync(
      projectDir(task.projectId, 'workspaces', 'level-code', file),
      projectDir(task.projectId, 'workspaces', 'game', file),
    );
  const levelConfig = projectDir(task.projectId, 'workspaces', 'level-code', 'game-config.json');
  const gameConfig = projectDir(task.projectId, 'workspaces', 'game', 'game-config.json');
  if (existsSync(levelConfig) && existsSync(gameConfig)) {
    const source = JSON.parse(readFileSync(levelConfig, 'utf8'));
    const target = JSON.parse(readFileSync(gameConfig, 'utf8'));
    if (!source.level || typeof source.level !== 'object' || Array.isArray(source.level))
      throw new Error('关卡交付缺少有效 game-config.json.level 参数');
    writeFileSync(gameConfig, JSON.stringify({ ...target, level: source.level }, null, 2));
  }
}
export async function docker(args: string[], options: any = {}) {
  const result = await execute('docker', args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}
export function seedWorkspace(task: Task, role: 'game' | 'level-code', inputs: any) {
  const dir = projectDir(task.projectId, 'workspaces', role);
  mkdirSync(dir, { recursive: true });
  const shell = join(config.root, 'templates/game');
  for (const file of [
    'shell.mjs',
    'shell.css',
    'index.html',
    'build.mjs',
    'serve.mjs',
    'package.json',
    'blueprint.html',
  ])
    cpSync(join(shell, file), join(dir, file));
  if (!existsSync(join(dir, 'level.mjs'))) cpSync(join(shell, 'level.mjs'), join(dir, 'level.mjs'));
  if (existsSync(projectDir(task.projectId, 'assets')))
    cpSync(projectDir(task.projectId, 'assets'), join(dir, 'assets'), { recursive: true });
  const manifest = {
    images: (inputs.art?.data.assets || []).map((a: any) => ({ id: a.id, file: a.file })),
    audio: (inputs.audio?.data.assets || []).map((a: any) => ({
      id: a.id,
      file: a.file,
      loop: a.loop,
      category: a.category,
      trigger: a.trigger,
    })),
  };
  writeFileSync(join(dir, 'asset-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(
    join(dir, 'contract.json'),
    JSON.stringify({ task: task.instruction, inputs, memory: contextFor(task, role) }, null, 2),
  );
  if (role === 'level-code') {
    const gameDir = projectDir(task.projectId, 'workspaces', 'game');
    for (const f of ['game-config.json', 'GAME_INTERFACE.md', 'game.mjs', 'game.test.mjs'])
      if (existsSync(join(gameDir, f))) cpSync(join(gameDir, f), join(dir, f));
  }
  return dir;
}
export async function runCoder(
  task: Task,
  role: 'game' | 'level-code',
  inputs: any,
  key: string,
  signal: AbortSignal,
) {
  let job = get<Job>('job', key);
  if (job?.status === 'completed') {
    if (role === 'level-code') syncLevel(task);
    return job.result;
  }
  const dir = projectDir(task.projectId, 'workspaces', role);
  const state = projectDir(task.projectId, 'sessions', role);
  mkdirSync(state, { recursive: true });
  const resultFile = join(state, key + '.result.json');
  const name = 'gagent-' + key.replaceAll(':', '-').slice(0, 85);
  const complete = (result: any) => {
    if (role === 'level-code') syncLevel(task);
    put('job', {
      id: key,
      projectId: task.projectId,
      taskId: task.id,
      role,
      container: name,
      createdAt: job?.createdAt || now(),
      ...job,
      status: 'completed',
      result,
      sessionId: result.sessionId,
      updatedAt: now(),
    });
    event(task.projectId, task.id, 'coder-complete', {
      role,
      usage: result.usage,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
    });
    return result;
  };
  if (existsSync(resultFile)) {
    let saved: any;
    try {
      saved = JSON.parse(readFileSync(resultFile, 'utf8'));
    } catch {
      /* An interrupted write is retried below. */
    }
    if (saved?.status === 'completed') return complete(saved);
  }
  let running = false;
  try {
    const info = JSON.parse((await docker(['inspect', name])).stdout)[0];
    running = info.State.Running;
  } catch {
    /* absent */
  }
  if (!running) {
    signal.throwIfAborted();
    seedWorkspace(task, role, inputs);
    try {
      await docker(['rm', name]);
    } catch {
      /* absent container */
    }
    const prompt = `你是 ${role === 'game' ? 'Game Coder' : 'Level Coder'}。读取 contract.json 和已有源码，执行本轮要求：${task.instruction}。\n${role === 'game' ? '实现可玩的完整躲避游戏，遵循 GDD、实际图片和音频。当前 level.mjs 可能为 bootstrap，游戏需消费标准 waves 接口，后续 Level Coder 将补齐。' : '按五章关卡设计实现真实的确定性 level.mjs 和验证器，完全兼容 GAME_INTERFACE.md。'}\n测试与构建必须真实运行。输出合同规定的 JSON。`;
    writeFileSync(
      join(state, key + '.input.json'),
      JSON.stringify({ prompt, role, maxTurns: config.maxTurns, timeoutMs: config.coderTimeoutMs }),
    );
    // Prior failed result is replaced by the new worker; preserve a copy for diagnosis.
    if (existsSync(resultFile)) cpSync(resultFile, join(state, key + '.previous-result.json'));
    writeFileSync(resultFile, JSON.stringify({ status: 'running' }));
    const env = {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: config.token,
      ANTHROPIC_BASE_URL: config.anthropicBase,
      ANTHROPIC_MODEL: config.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.model,
      CLAUDE_CODE_SUBAGENT_MODEL: config.model,
    };
    const names = [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
    ];
    await docker(
      [
        'run',
        '-d',
        '--name',
        name,
        '--label',
        'game-agent-owned=true',
        '--memory',
        '3g',
        '--cpus',
        '2',
        '--pids-limit',
        '256',
        '--mount',
        `type=bind,src=${state},dst=/state`,
        '--mount',
        `type=bind,src=${dir},dst=/work`,
        ...names.flatMap((n) => ['--env', n]),
        config.image,
        'node',
        '--import',
        'tsx',
        'src/coder-worker.ts',
        key,
      ],
      { env, timeout: 60000 },
    );
  }
  job = put<Job>('job', {
    id: key,
    projectId: task.projectId,
    taskId: task.id,
    role,
    status: 'running',
    container: name,
    createdAt: job?.createdAt || now(),
    updatedAt: now(),
  });
  event(task.projectId, task.id, 'coder-start', { role, container: name, resumed: running });
  let eventCount = 0;
  while (true) {
    if (signal.aborted) {
      await docker(['stop', '--time', '5', name]).catch(() => {});
      put('job', { ...job, status: 'interrupted', updatedAt: now() });
      signal.throwIfAborted();
    }
    const logs = join(state, key + '.events.jsonl');
    if (existsSync(logs)) {
      const lines = readFileSync(logs, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(eventCount)) {
        try {
          event(task.projectId, task.id, 'coder-event', { role, ...JSON.parse(line) });
          eventCount++;
        } catch {
          break;
        } // Partial final line is retried on the next poll.
      }
    }
    if (existsSync(resultFile)) {
      let result: any;
      try {
        result = JSON.parse(readFileSync(resultFile, 'utf8'));
      } catch {
        /* worker is writing */
      }
      if (result?.status === 'completed') {
        return complete(result);
      }
      if (result?.status === 'failed') {
        put('job', {
          ...job,
          status: 'failed',
          error: result.error,
          sessionId: result.sessionId,
          updatedAt: now(),
        });
        throw new Error('编码任务失败：' + result.error);
      }
    }
    const info = JSON.parse((await docker(['inspect', name])).stdout)[0];
    if (!info.State.Running) {
      const error = `编码容器退出 ${info.State.ExitCode}，结果文件待恢复核对`;
      put('job', { ...job, status: 'interrupted', error, updatedAt: now() });
      throw new Error(error);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
