import { z } from 'zod';
import { config, now, redact } from './config.js';
import { db, event, get, put } from './store.js';
import { contextFor } from './memory.js';
import type { Task } from './contracts.js';
import { readChatStream } from './chat-stream.js';

export interface AgentTool {
  name: string;
  description: string;
  schema: z.ZodType;
  run: (input: any) => Promise<any>;
}
export async function modelRole<T>(
  task: Task,
  role: string,
  instructions: string,
  input: any,
  schema: z.ZodType<T>,
  tools: AgentTool[] = [],
  signal?: AbortSignal,
  cacheKey?: string,
  validate?: (result: T) => void,
): Promise<T> {
  signal?.throwIfAborted();
  const key = cacheKey || `${task.id}:${role}`;
  const cached = get<any>('model-result', key);
  if (cached) {
    try {
      const result = schema.parse(cached.result);
      validate?.(result);
      return result;
    } catch (error) {
      event(task.projectId, task.id, 'cached-output-invalid', { role, key, error: String(error) });
      db.prepare('DELETE FROM records WHERE kind=? AND id=?').run('model-result', key);
    }
  }
  if (!config.token) throw new Error('请在本地 .env 配置 ARK_AGENT_PLAN_API_KEY');
  const memory = contextFor(task, role);
  const jsonSchema = z.toJSONSchema(schema);
  const initial: any[] = [
    {
      role: 'system',
      content: `${memory.core}\n${memory.handbook}\n角色：${role}\n${instructions}\n最终输出为 JSON 对象，严格匹配以下结构：${JSON.stringify(jsonSchema)}。工具调用使用提供的 function tools。`,
    },
    { role: 'user', content: JSON.stringify({ input, memory }) },
  ];
  const prior = get<any>('conversation', key);
  const messages: any[] = prior?.messages?.length ? prior.messages : initial;
  messages[0] = initial[0];
  if (prior) event(task.projectId, task.id, 'conversation-resume', { role, messages: messages.length, key });
  let validationRetries = 0;
  let consecutiveToolFailures = 0;
  for (let round = 0; round < config.toolRounds; round++) {
    signal?.throwIfAborted();
    const started = Date.now();
    const request = {
      model: config.model,
      messages,
      // Real expert and level-design responses exhausted 12k before completing their JSON.
      max_tokens: 24000,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) },
            })),
            tool_choice: round === 0 && messages.length === 2 ? 'required' : 'auto',
          }
        : { response_format: { type: 'json_object' } }),
    };
    event(task.projectId, task.id, 'model-start', { role, round, model: config.model });
    put('conversation', { id: key, projectId: task.projectId, role, messages, updatedAt: now() });
    let data: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
      signal?.throwIfAborted();
      const idle = new AbortController();
      const idleError = new DOMException('文本连接连续 4 分钟未收到有效流片段', 'TimeoutError');
      let idleTimer = setTimeout(() => idle.abort(idleError), 240_000);
      try {
        const response = await fetch(config.textBase + '/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.any([idle.signal, AbortSignal.timeout(600_000), ...(signal ? [signal] : [])]),
        });
        if (!response.ok)
          throw new Error(redact(`方舟 ${response.status}: ${(await response.text()).slice(0, 3000)}`));
        data = await readChatStream(response, (value) => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => idle.abort(idleError), 240_000);
          event(task.projectId, task.id, 'model-progress', { role, round, attempt, ...value });
        });
        break;
      } catch (error) {
        if (attempt === 1 && error instanceof Error && error.name === 'TimeoutError' && !signal?.aborted) {
          event(task.projectId, task.id, 'model-retry', {
            role,
            round,
            attempt: 2,
            reason: '文本响应超时，自动重试一次',
            usage: 'previous-attempt-unavailable',
          });
          continue;
        }
        throw error;
      } finally {
        clearTimeout(idleTimer);
      }
    }
    event(task.projectId, task.id, 'model-usage', {
      role,
      round,
      durationMs: Date.now() - started,
      usage: data.usage,
      model: data.model,
      responseId: data.id,
    });
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('模型返回缺少 message');
    const message = choice.message;
    messages.push(message);
    if (message.tool_calls?.length) {
      for (const call of message.tool_calls) {
        const tool = tools.find((t) => t.name === call.function.name);
        let result;
        try {
          if (!tool) throw new Error('角色没有该工具');
          const args = tool.schema.parse(JSON.parse(call.function.arguments));
          event(task.projectId, task.id, 'tool-start', { role, tool: tool.name, arguments: args });
          result = await tool.run(args);
          consecutiveToolFailures = 0;
          event(task.projectId, task.id, 'tool-result', { role, tool: tool.name, result });
        } catch (e) {
          result = { error: redact(String(e)) };
          event(task.projectId, task.id, 'tool-error', { role, tool: call.function.name, ...result });
          if (++consecutiveToolFailures >= 2)
            throw new Error(`连续工具失败，已保存现有产物：${result.error}`);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      put('conversation', { id: key, projectId: task.projectId, role, messages, updatedAt: now() });
      continue;
    }
    try {
      if (choice.finish_reason !== 'stop') throw new Error(`输出未完成：${choice.finish_reason}`);
      const result = schema.parse(JSON.parse(message.content));
      validate?.(result);
      put('model-result', { id: key, projectId: task.projectId, role, result, at: now() });
      put('conversation', { id: key, projectId: task.projectId, role, messages, updatedAt: now() });
      return result;
    } catch (error) {
      event(task.projectId, task.id, 'model-output-invalid', {
        role,
        round,
        finishReason: choice.finish_reason,
        correction: validationRetries + 1,
        error: redact(String(error)).slice(0, 2000),
      });
      if (++validationRetries > 2) throw new Error(`模型结构化产物校验失败：${String(error).slice(0, 2000)}`);
      messages.push({ role: 'user', content: '请修正 JSON 输出并补齐字段：' + String(error).slice(0, 3000) });
      put('conversation', { id: key, projectId: task.projectId, role, messages, updatedAt: now() });
    }
  }
  throw new Error(`角色 ${role} 达到工具轮次上限 ${config.toolRounds}，已有工具产物已保存。`);
}
