import test from 'node:test';
import assert from 'node:assert/strict';
import { coderProgress } from '../src/coder-progress.js';

test('stream progress reports bounded metadata and ignores reasoning content', () => {
  const events: any[] = [];
  const update = coderProgress((e) => events.push(e));
  update({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }, 0);
  update(
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } },
    6000,
  );
  assert.equal(events.length, 0);
  update({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'Write' } }, 0);
  update(
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: 'x'.repeat(1100) },
    },
    2000,
  );
  assert.equal(events.length, 0);
  update(
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'SENSITIVE' } },
    6000,
  );
  assert.equal(events[0].characters, 1109);
  assert.equal(events[0].phase, 'generating');
  update({ type: 'content_block_stop', index: 1 }, 6100);
  assert.equal(events[1].phase, 'generated');
  assert(!JSON.stringify(events).includes('SENSITIVE'));
  assert(!JSON.stringify(events).includes('PRIVATE'));
  update({ type: 'message_start' }, 7000);
  update({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'old' } }, 12000);
  assert.equal(events.length, 2);
});
