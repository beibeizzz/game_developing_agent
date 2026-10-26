// Ark's OpenAI-compatible SSE response, assembled into the existing role-loop contract.
export async function readChatStream(
  response: Response,
  progress: (value: { chunks: number; outputChars: number }) => void,
) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
  if (!response.body) throw new Error('文本流缺少响应体');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const message: any = { role: 'assistant', content: '' };
  const calls = new Map<number, any>();
  let pending = '';
  let id: string | undefined, model: string | undefined, usage: any, finishReason: string | undefined;
  let chunks = 0,
    outputChars = 0,
    lastProgress = 0,
    done = false;
  function consume(frame: string) {
    const payload = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    const data = JSON.parse(payload);
    if (data.error) throw new Error('文本流错误：' + JSON.stringify(data.error));
    id = data.id || id;
    model = data.model || model;
    usage = data.usage || usage;
    const choice = data.choices?.find((item: any) => (item.index ?? 0) === 0);
    if (choice) {
      finishReason = choice.finish_reason || finishReason;
      const delta = choice.delta || {};
      if (delta.content) {
        message.content += delta.content;
        outputChars += delta.content.length;
      }
      // Preserve provider conversation fields internally; progress contains only counts.
      if (delta.reasoning_content)
        message.reasoning_content = (message.reasoning_content || '') + delta.reasoning_content;
      for (const fragment of delta.tool_calls || []) {
        const call = calls.get(fragment.index) || {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.function.name += fragment.function.name;
        if (fragment.function?.arguments) {
          call.function.arguments += fragment.function.arguments;
          outputChars += fragment.function.arguments.length;
        }
        calls.set(fragment.index, call);
      }
    }
    chunks++;
    if (Date.now() - lastProgress >= 5000) {
      progress({ chunks, outputChars });
      lastProgress = Date.now();
    }
  }
  try {
    while (!done) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      // Normalize complete CRLF pairs, leaving a trailing CR for the next read.
      pending = pending.replaceAll('\r\n', '\n');
      let end: number;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        consume(pending.slice(0, end));
        pending = pending.slice(end + 2);
      }
      if (chunk.done) {
        if (pending.trim()) consume(pending);
        break;
      }
    }
    if (!finishReason) throw new Error('文本流提前结束，已保留本轮输入，可继续任务');
    if (calls.size)
      message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    progress({ chunks, outputChars });
    return { id, model, usage, choices: [{ finish_reason: finishReason, message }] };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
