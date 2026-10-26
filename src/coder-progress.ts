// Report streamed output volume without exposing partial code or reasoning blocks.
export function coderProgress(emit: (event: Record<string, unknown>) => void) {
  const blocks = new Map<number, { name: string; characters: number; emittedAt: number }>();
  return (event: any, time = Date.now()) => {
    if (event.type === 'message_start') blocks.clear();
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (!['text', 'tool_use'].includes(block.type)) return;
      const name = block.type === 'tool_use' ? `生成 ${block.name} 参数` : '生成说明';
      blocks.set(event.index, { name, characters: 0, emittedAt: time });
    }
    const block = blocks.get(event.index);
    if (!block) return;
    if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (!['text_delta', 'input_json_delta'].includes(delta.type)) return;
      block.characters += (delta.text || delta.partial_json || '').length;
      if (time - block.emittedAt < 5000) return;
      block.emittedAt = time;
      emit({ type: 'progress', name: block.name, characters: block.characters, phase: 'generating' });
    }
    if (event.type === 'content_block_stop') {
      if (block.characters >= 1000)
        emit({ type: 'progress', name: block.name, characters: block.characters, phase: 'generated' });
      blocks.delete(event.index);
    }
  };
}
