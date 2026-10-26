import test from 'node:test';
import assert from 'node:assert/strict';
import { readChatStream } from '../src/chat-stream.js';

function stream(frames: any[], width = 7) {
  const data = new TextEncoder().encode(
    frames
      .map((frame) => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\r\n\r\n')
      .join(''),
  );
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= data.length) return controller.close();
        controller.enqueue(data.slice(offset, (offset += width)));
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}
test('SSE decodes split UTF-8, keeps final usage, and exposes only progress counts', async () => {
  const seen: any[] = [];
  const result = await readChatStream(
    stream([
      {
        id: 'fixture',
        model: 'synthetic',
        choices: [{ index: 0, delta: { reasoning_content: 'internal synthetic text' } }],
      },
      { choices: [{ index: 0, delta: { content: '{"summary":"太空' } }] },
      { choices: [{ index: 0, delta: { content: '躲避"}' }, finish_reason: 'stop' }] },
      { choices: [], usage: { total_tokens: 123 } },
      '[DONE]',
    ]),
    (value) => seen.push(value),
  );
  assert.deepEqual(JSON.parse(result.choices[0].message.content), { summary: '太空躲避' });
  assert.equal(result.usage.total_tokens, 123);
  assert.equal(result.id, 'fixture');
  assert.equal(seen.at(-1).chunks, 4);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['chunks', 'outputChars']);
  assert.equal(seen.at(-1).outputChars, '{"summary":"太空躲避"}'.length);
});
test('SSE assembles interleaved tool arguments before the tool loop can execute them', async () => {
  const result = await readChatStream(
    stream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'first', function: { name: 'lookup', arguments: '{"query":' } },
                { index: 1, id: 'second', function: { name: 'read', arguments: '{' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '"id":2}' } },
                { index: 0, function: { arguments: '"星空"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      '[DONE]',
    ]),
    () => {},
  );
  const calls = result.choices[0].message.tool_calls;
  assert.deepEqual(
    calls.map((c: any) => c.id),
    ['first', 'second'],
  );
  assert.deepEqual(
    calls.map((c: any) => JSON.parse(c.function.arguments)),
    [{ query: '星空' }, { id: 2 }],
  );
});
test('truncated and error streams fail without accepting partial output', async () => {
  await assert.rejects(
    readChatStream(stream([{ choices: [{ delta: { content: '{' } }] }]), () => {}),
    /提前结束/,
  );
  await assert.rejects(
    readChatStream(stream([{ error: { message: 'synthetic failure' } }]), () => {}),
    /synthetic failure/,
  );
});
