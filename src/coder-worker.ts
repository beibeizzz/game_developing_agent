// Executed inside the local Linux container, independently of the workbench process.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { verifyCoderResult } from './coder-verification.js';
import { allowedCoderTool, toolRestriction } from './coder-policy.js';
import { coderProgress } from './coder-progress.js';

const jobId = process.argv[2];
if (!/^[\w:-]+$/.test(jobId || '')) throw new Error('Invalid job');
const input = JSON.parse(readFileSync(`/state/${jobId}.input.json`, 'utf8'));
const memory = JSON.parse(readFileSync('/work/contract.json', 'utf8')).memory;
const sessionPath = '/state/session.json';
const session = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf8')) : {};
const secret = process.env.ANTHROPIC_AUTH_TOKEN || '';
const clean = (text: string) => (secret ? text.split(secret).join('[REDACTED]') : text);
const log = (data: any) =>
  appendFileSync(
    `/state/${jobId}.events.jsonl`,
    clean(JSON.stringify({ ...data, at: new Date().toISOString() })) + '\n',
  );
const controller = new AbortController();
const progress = coderProgress(log);
const timer = setTimeout(() => controller.abort(), input.timeoutMs);
let result: any;
try {
  for await (const message of query({
    prompt: input.prompt,
    options: {
      cwd: '/work',
      model: process.env.ANTHROPIC_MODEL || 'ark-code-latest',
      resume: session.sessionId,
      maxTurns: input.maxTurns,
      abortController: controller,
      includePartialMessages: true,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      permissionMode: 'default',
      tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== 'PreToolUse') return {};
                const allowed = allowedCoderTool(
                  input.tool_name,
                  input.tool_input as Record<string, unknown>,
                );
                log({ type: 'permission', phase: 'PreToolUse', name: input.tool_name, allowed });
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: allowed ? 'allow' : 'deny',
                    permissionDecisionReason: allowed ? 'Within coding contract' : toolRestriction,
                  },
                };
              },
            ],
          },
        ],
      },
      systemPrompt: [
        memory?.core,
        memory?.handbook,
        readFileSync('/opt/agent/templates/CODER_CONTRACT.md', 'utf8'),
      ]
        .filter(Boolean)
        .join('\n\n'),
      canUseTool: async (name, args) => {
        const allowed = allowedCoderTool(name, args);
        return allowed
          ? { behavior: 'allow', updatedInput: args }
          : {
              behavior: 'deny',
              message: toolRestriction,
            };
      },
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
            testsPassed: { type: 'boolean' },
            interface: { type: 'string' },
          },
          required: ['summary', 'files', 'testsPassed', 'interface'],
          additionalProperties: false,
        },
      },
      stderr: (text) => log({ type: 'stderr', text: clean(text).slice(0, 1000) }),
    },
  })) {
    if (message.type === 'stream_event') progress(message.event);
    if (message.type === 'system' && message.subtype === 'init') {
      writeFileSync(sessionPath, JSON.stringify({ sessionId: message.session_id }));
      log({ type: 'session', sessionId: message.session_id });
    }
    if (message.type === 'assistant')
      for (const block of message.message.content) {
        if (block.type === 'tool_use') log({ type: 'tool', name: block.name, input: block.input });
        if (block.type === 'text') log({ type: 'text', text: block.text });
      }
    if (message.type === 'result') {
      result = message;
      log({ type: 'result', subtype: message.subtype, usage: message.usage, sessionId: message.session_id });
    }
  }
  const { testOutput, buildOutput } = verifyCoderResult(input.role, result, '/work');
  writeFileSync(`/state/${jobId}.tests.txt`, testOutput);
  writeFileSync(`/state/${jobId}.build.txt`, buildOutput);
  writeFileSync(
    `/state/${jobId}.result.json`,
    clean(
      JSON.stringify({
        status: 'completed',
        result: result.structured_output,
        usage: result.usage,
        sessionId: result.session_id,
        durationMs: result.duration_ms,
        testOutput,
        buildOutput,
      }),
    ),
  );
} catch (e) {
  const error = clean(String(e));
  log({ type: 'error', error });
  writeFileSync(
    `/state/${jobId}.result.json`,
    JSON.stringify({
      status: 'failed',
      error,
      usage: result?.usage,
      sessionId: result?.session_id || session.sessionId,
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
