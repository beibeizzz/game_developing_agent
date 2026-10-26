import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareSprite } from '../src/sprites.js';

test('sprite processing removes lime backing and preserves a readable magenta/cyan subject', async () => {
  const raw = Buffer.alloc(100 * 100 * 4);
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) {
      const offset = (y * 100 + x) * 4;
      const subject = x >= 45 && x < 55 && y >= 40 && y < 60;
      raw.set(subject ? (x < 50 ? [255, 30, 200, 255] : [30, 220, 255, 255]) : [0, 255, 0, 255], offset);
    }
  raw.set([30, 220, 255, 255], (98 * 100 + 98) * 4);
  const input = await sharp(raw, { raw: { width: 100, height: 100, channels: 4 } })
    .png()
    .toBuffer();
  const { data, info } = await sharp(await prepareSprite(input))
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.equal(data[3], 0);
  let visible = 0,
    pink = 0,
    cyan = 0;
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3] > 200) {
      visible++;
      if (data[i] > 200 && data[i + 2] > 150) pink++;
      if (data[i + 1] > 150 && data[i + 2] > 200) cyan++;
    }
  assert.ok(visible > 80000, 'small source content should occupy a readable proportion');
  assert.ok(pink > 30000 && cyan > 30000, 'both approved neon colors must remain visible');
});

test('empty keyed sprite fails instead of silently shipping an invisible asset', async () => {
  const input = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00ff00' } })
    .png()
    .toBuffer();
  await assert.rejects(prepareSprite(input), /可见主体/);
});
