import sharp from 'sharp';

/** Key the lime backing and normalize visible content so small game sprites remain readable. */
export async function prepareSprite(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let i = 0; i < data.length; i += 4) {
    const excess = data[i + 1] - Math.max(data[i], data[i + 2]);
    if (excess > 60 && data[i + 1] > 120)
      data[i + 3] = Math.min(
        data[i + 3],
        Math.max(0, Math.round(255 * (1 - Math.min(1, (excess - 60) / 70)))),
      );
    if (!data[i + 3]) data[i] = data[i + 1] = data[i + 2] = 0;
    else if (data[i + 3] < 255 && excess > 0) data[i + 1] = Math.max(data[i], data[i + 2]);
    if (data[i + 3] > 32) {
      mask[i / 4] = 1;
    }
  }
  // Isolated backing artifacts must not shift the game object's center or shrink its visible size.
  const queue = new Int32Array(mask.length);
  let largest = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let head = 0,
      tail = 1,
      l = info.width,
      r = -1,
      t = info.height,
      b = -1;
    queue[0] = start;
    mask[start] = 0;
    while (head < tail) {
      const pixel = queue[head++],
        x = pixel % info.width,
        y = Math.floor(pixel / info.width);
      l = Math.min(l, x);
      r = Math.max(r, x);
      t = Math.min(t, y);
      b = Math.max(b, y);
      for (const next of [
        x > 0 ? pixel - 1 : -1,
        x + 1 < info.width ? pixel + 1 : -1,
        pixel - info.width,
        pixel + info.width,
      ]) {
        if (next >= 0 && next < mask.length && mask[next]) {
          mask[next] = 0;
          queue[tail++] = next;
        }
      }
    }
    if (tail > largest) {
      largest = tail;
      left = l;
      right = r;
      top = t;
      bottom = b;
    }
  }
  if (right < left || bottom < top) throw new Error('精灵处理后缺少可见主体');
  return sharp(data, { raw: info })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .resize(448, 448, { fit: 'contain', background: '#00000000' })
    .extend({ top: 32, bottom: 32, left: 32, right: 32, background: '#00000000' })
    .png()
    .toBuffer();
}
