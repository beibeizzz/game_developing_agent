import { z } from 'zod';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import sharp from 'sharp';
import { load } from 'cheerio';
import { webFetch, publicUrl } from './network.js';
import { config, now, redact } from './config.js';
import { projectDir, put, get, list, event } from './store.js';
import type { Task } from './contracts.js';
import type { AgentTool } from './model.js';
import { prepareSprite } from './sprites.js';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/);
const hash = (data: any) => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 12);
export function assetPath(project: string, file: string) {
  if (!/^assets\/[\w.-]+$/.test(file)) throw new Error('素材路径无效');
  return projectDir(project, file);
}
export function wav(samples: Float32Array, rate = 22050) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((n, i) =>
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, n)) * 32767), 44 + i * 2),
  );
  return buffer;
}
export async function searchReferences(task: Task, query: string) {
  const cached = get<any>('research-source', task.id + ':' + hash(query));
  if (cached) return cached.results;
  const url = new URL('https://store.steampowered.com/search/');
  url.searchParams.set('term', query);
  const response = await webFetch(url.href);
  const search = load(await response.text());
  const items = search('a.search_result_row')
    .toArray()
    .slice(0, 4)
    .map((item) => ({
      title: search(item).find('.title').text(),
      url: search(item).attr('href')!.split('?')[0],
      excerpt: search(item).text().trim().replace(/\s+/g, ' ').slice(0, 600),
      thumbnail: search(item).find('img').attr('src') || '',
    }));
  const results = await Promise.all(
    items.map(async (item) => {
      let imageUrl = '',
        originalImageUrl = '',
        pageStatus = 'snippet-only';
      try {
        const page = await webFetch(item.url, 12000);
        const text = (await page.text()).slice(0, 2000000);
        const html = load(text);
        const excerpt = html('.game_description_snippet').text().trim();
        if (excerpt) item.excerpt = excerpt.slice(0, 1800);
        const screenshotJSON = text
          .replaceAll('&quot;', '"')
          .replaceAll('&amp;', '&')
          .match(/"screenshots":(\[.*?\])/s)?.[1];
        let screenshot = '';
        try {
          if (screenshotJSON) screenshot = JSON.parse(screenshotJSON)[0]?.standard || '';
        } catch {
          /* use page thumbnail */
        }
        const raw =
          screenshot ||
          html('meta[property="og:image"],meta[name="twitter:image"]').first().attr('content') ||
          item.thumbnail;
        if (raw) {
          originalImageUrl = publicUrl(new URL(raw, item.url).href).href;
          const picture = await webFetch(originalImageUrl, 12000);
          const bytes = Buffer.from(await picture.arrayBuffer());
          if (bytes.length > 10000000) throw new Error('参考图过大');
          mkdirSync(projectDir(task.projectId, 'references'), { recursive: true });
          const filename = 'web-' + hash(originalImageUrl) + '.png';
          await sharp(bytes, { limitInputPixels: 20000000 })
            .resize({ width: 800, height: 600, fit: 'inside', withoutEnlargement: true })
            .png()
            .toFile(projectDir(task.projectId, 'references', filename));
          imageUrl = `/api/projects/${task.projectId}/files/references/${filename}`;
        }
        pageStatus = 'fetched';
      } catch (error) {
        pageStatus = String(error).slice(0, 200);
      }
      return {
        ...item,
        id: hash(item.url),
        imageUrl,
        originalImageUrl,
        pageStatus,
        source: 'Steam public store search / source page and screenshot',
        usage: 'design-reference-only',
      };
    }),
  );
  if (!results.length) throw new Error('检索无结果，请调整关键词');
  put('research-source', {
    id: task.id + ':' + hash(query),
    projectId: task.projectId,
    taskId: task.id,
    query,
    results,
    at: now(),
  });
  return results;
}
export function researchTools(task: Task): AgentTool[] {
  return [
    {
      name: 'search_references',
      description:
        '联网检索 Steam 公开商店的游戏资料与真实截图。query 使用短游戏名或关键词，如 Asteroids、Geometry Wars、Super Hexagon、dodge。结果仅用于设计调研。',
      schema: z.object({ query: z.string().min(2).max(160) }),
      run: ({ query }) => searchReferences(task, query),
    },
    {
      name: 'local_references',
      description: '读取用户上传的本地参考及来源说明。',
      schema: z.object({}),
      run: async () => list('reference', task.projectId),
    },
  ];
}
export function mediaTools(task: Task, signal?: AbortSignal, imageIds?: readonly string[]): AgentTool[] {
  mkdirSync(projectDir(task.projectId, 'assets'), { recursive: true });
  const save = (id: string, parameters: any, file: string, source: string, usage?: any) => {
    const value = {
      id: task.id + ':' + id + ':' + hash(parameters),
      projectId: task.projectId,
      taskId: task.id,
      file,
      parameters,
      source,
      usage,
      at: now(),
    };
    put('asset', value);
    return value;
  };
  return [
    {
      name: 'generate_image',
      description:
        '生成真实图片。精灵使用纯绿色衬底并处理透明，前景避免纯绿；背景使用完整画面。references 填已生成 assets 路径，用于 Style/Entity 引用；每个文件独立保存。',
      schema: z.object({
        id: idSchema,
        prompt: z.string().min(10),
        references: z.array(z.string()).max(3),
        transparentSprite: z.boolean(),
      }),
      run: async (args) => {
        if (imageIds && !imageIds.includes(args.id))
          throw new Error(
            `图片 ID 必须来自已批准 GDD 的 image 清单：${imageIds.join(', ')}；procedural 资源由代码绘制。`,
          );
        const legacyFile = `assets/${args.id}-${hash(args)}.png`;
        const file = args.transparentSprite ? legacyFile.replace('.png', '-sprite-v3.png') : legacyFile;
        const full = assetPath(task.projectId, file);
        if (existsSync(full))
          return (
            list<any>('asset', task.projectId).find((a) => a.file === file) ||
            save(args.id, args, file, `generated:${config.imageModel}; recovered-file`)
          );
        if (args.transparentSprite && existsSync(assetPath(task.projectId, legacyFile))) {
          const original = list<any>('asset', task.projectId).find((a) => a.file === legacyFile);
          writeFileSync(full, await prepareSprite(readFileSync(assetPath(task.projectId, legacyFile))));
          return save(
            args.id,
            args,
            file,
            `${original?.source || 'generated:' + config.imageModel}; normalized-from:${legacyFile}`,
          );
        }
        const images = args.references.map(
          (p: string) =>
            'data:image/png;base64,' + readFileSync(assetPath(task.projectId, p)).toString('base64'),
        );
        const body = {
          model: config.imageModel,
          prompt:
            args.prompt +
            (args.transparentSprite
              ? ' Single isolated sprite, solid pure lime green #00ff00 background, no green foreground, no text, centered, no cast shadow.'
              : ''),
          size: '2K',
          response_format: 'b64_json',
          watermark: true,
          ...(images.length ? { image: images } : {}),
        };
        const res = await fetch(config.textBase + '/images/generations', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(240000)])
            : AbortSignal.timeout(240000),
        });
        if (!res.ok) throw new Error(redact(`生图失败 ${res.status} ${(await res.text()).slice(0, 1500)}`));
        const data: any = await res.json();
        const item = data.data?.[0];
        if (!item) throw new Error('生图返回缺少文件');
        const raw = item.b64_json
          ? Buffer.from(item.b64_json, 'base64')
          : Buffer.from(await (await fetch(item.url)).arrayBuffer());
        if (args.transparentSprite) {
          writeFileSync(full, await prepareSprite(raw));
        } else await sharp(raw).resize({ width: 1280, height: 1280, fit: 'inside' }).png().toFile(full);
        event(task.projectId, task.id, 'media-usage', { tool: 'image', usage: data.usage, file });
        return save(args.id, args, file, `generated:${config.imageModel}`, data.usage);
      },
    },
    {
      name: 'compose_layout',
      description:
        '将真实素材按像素坐标合成页面框架 PNG。items 引用已生成的 assets 路径；circles 和 labels 可示意程序绘制的碰撞环与 HUD。',
      schema: z.object({
        id: idSchema,
        width: z.number().int().min(200).max(1920),
        height: z.number().int().min(200).max(1920),
        background: z.string(),
        items: z.array(
          z.object({
            file: z.string(),
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            width: z.number().int().min(1),
            height: z.number().int().min(1),
          }),
        ),
        circles: z
          .array(
            z.object({
              x: z.number(),
              y: z.number(),
              radius: z.number().positive(),
              stroke: z.string(),
              width: z.number().positive(),
            }),
          )
          .optional(),
        labels: z
          .array(
            z.object({
              x: z.number(),
              y: z.number(),
              text: z.string(),
              color: z.string(),
              fontSize: z.number().positive(),
            }),
          )
          .optional(),
      }),
      run: async (args) => {
        const file = `assets/${args.id}-${hash(args)}.png`;
        const layers = await Promise.all(
          args.items.map(async (item: any) => ({
            input: await sharp(assetPath(task.projectId, item.file))
              .resize(item.width, item.height, { fit: 'contain', background: '#00000000' })
              .png()
              .toBuffer(),
            left: item.x,
            top: item.y,
          })),
        );
        if (args.circles?.length || args.labels?.length) {
          const escape = (value: string) =>
            value.replace(
              /[&<>"']/g,
              (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
            );
          const circles = (args.circles || [])
            .map(
              (c: any) =>
                `<circle cx="${c.x}" cy="${c.y}" r="${c.radius}" fill="none" stroke="${escape(c.stroke)}" stroke-width="${c.width}"/>`,
            )
            .join('');
          const labels = (args.labels || [])
            .map(
              (t: any) =>
                `<text x="${t.x}" y="${t.y}" fill="${escape(t.color)}" font-family="sans-serif" font-size="${t.fontSize}">${escape(t.text)}</text>`,
            )
            .join('');
          layers.push({
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="${args.width}" height="${args.height}">${circles}${labels}</svg>`,
            ),
            left: 0,
            top: 0,
          });
        }
        await sharp({
          create: { width: args.width, height: args.height, channels: 4, background: args.background },
        })
          .composite(layers)
          .png()
          .toFile(assetPath(task.projectId, file));
        return save(args.id, args, file, 'composed-from-generated-assets');
      },
    },
    {
      name: 'inspect_layout',
      description: '用视觉模型检查实际框架图的布局与可读性，返回观测。',
      schema: z.object({ file: z.string(), question: z.string() }),
      run: async ({ file, question }) => {
        const image =
          'data:image/png;base64,' + readFileSync(assetPath(task.projectId, file)).toString('base64');
        const res = await fetch(config.textBase + '/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + config.token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            max_tokens: 6000,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: question + '\n请简洁逐项报告实际观察和明确问题。' },
                  { type: 'image_url', image_url: { url: image } },
                ],
              },
            ],
          }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(240000)])
            : AbortSignal.timeout(240000),
        });
        if (!res.ok) throw new Error(`视觉检查 ${res.status}: ${(await res.text()).slice(0, 1000)}`);
        const data: any = await res.json();
        event(task.projectId, task.id, 'model-usage', { role: 'visual-layout', usage: data.usage });
        const observation = data.choices?.[0]?.message?.content;
        if (!observation) throw new Error('视觉检查缺少实际观测');
        return put('visual-inspection', {
          id: task.id + ':' + hash({ file, question }),
          projectId: task.projectId,
          taskId: task.id,
          file,
          question,
          observation,
          usage: data.usage,
          at: now(),
        });
      },
    },
    {
      name: 'synthesize_audio',
      description: '程序合成原创 BGM 或效果音，记录音符/频率参数与原创来源。bgm 循环和弦，其他类别短音效。',
      schema: z.object({
        id: idSchema,
        category: z.enum(['bgm', 'interaction', 'state', 'ui']),
        seconds: z.number().min(0.05).max(20),
        frequencies: z.array(z.number().min(40).max(4000)).min(1).max(12),
        volume: z.number().min(0.01).max(0.6),
      }),
      run: async (args) => {
        const rate = 22050;
        const count = Math.floor(args.seconds * rate);
        const samples = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const t = i / rate;
          const envelope =
            args.category === 'bgm'
              ? Math.min(1, t * 12, (args.seconds - t) * 12)
              : Math.exp((-t * 6) / args.seconds) * Math.min(1, t * 100);
          const note =
            args.frequencies[
              Math.min(args.frequencies.length - 1, Math.floor((t / args.seconds) * args.frequencies.length))
            ];
          samples[i] =
            (Math.sin(2 * Math.PI * note * t) + 0.25 * Math.sin(4 * Math.PI * note * t)) *
            args.volume *
            envelope;
        }
        const file = `assets/${args.id}-${hash(args)}.wav`;
        writeFileSync(assetPath(task.projectId, file), wav(samples, rate));
        return save(args.id, args, file, 'original-procedural-audio; project-generated');
      },
    },
    {
      name: 'synthesize_speech',
      description: '通过 Agent Plan TTS 2.0 合成中文语音 WAV，适用于引导和状态播报。',
      schema: z.object({ id: idSchema, text: z.string().min(1).max(200) }),
      run: async (args) => {
        const file = `assets/${args.id}-${hash(args)}.wav`;
        if (existsSync(assetPath(task.projectId, file)))
          return (
            list<any>('asset', task.projectId).find((a) => a.file === file) ||
            save(args.id, args, file, 'generated:doubao-seed-tts-2.0; recovered-file')
          );
        const res = await fetch('https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional', {
          method: 'POST',
          headers: {
            'X-Api-Key': config.token,
            'X-Api-Resource-Id': 'seed-tts-2.0',
            'X-Control-Require-Usage-Tokens-Return': '*',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            req_params: {
              text: args.text,
              speaker: 'zh_female_vv_uranus_bigtts',
              audio_params: { format: 'pcm', sample_rate: 16000 },
            },
          }),
          signal: signal || AbortSignal.timeout(120000),
        });
        if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);
        const chunks: Buffer[] = [];
        let terminal = false;
        const usage: any[] = [];
        for (const line of (await res.text()).split('\n').filter((x) => x.trim())) {
          const packet = JSON.parse(line);
          if (packet.usage) usage.push(packet.usage);
          if (packet.code === 20000000) {
            terminal = true;
            break;
          }
          if (packet.code) throw new Error(redact(JSON.stringify(packet)));
          if (packet.data) chunks.push(Buffer.from(packet.data, 'base64'));
        }
        const pcm = Buffer.concat(chunks);
        if (!terminal || pcm.length < 100) throw new Error('TTS 缺少完成音频');
        const values = new Float32Array(pcm.length / 2);
        for (let i = 0; i < values.length; i++) values[i] = pcm.readInt16LE(i * 2) / 32768;
        writeFileSync(assetPath(task.projectId, file), wav(values, 16000));
        event(task.projectId, task.id, 'media-usage', { tool: 'tts', usage, file });
        return save(args.id, args, file, 'generated:doubao-seed-tts-2.0', usage);
      },
    },
    {
      name: 'list_assets',
      description: '列出当前项目已存在的真实素材及来源，可复用未受影响资源。',
      schema: z.object({}),
      run: async () => list('asset', task.projectId),
    },
  ];
}
export function sourceSnapshot(projectId: string, buildId?: string) {
  const root = buildId
    ? projectDir(projectId, 'builds', buildId, 'source')
    : projectDir(projectId, 'workspaces', 'game');
  const files: Record<string, string> = {};
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir, { withFileTypes: true })) {
      if (
        ['node_modules', '.git', 'dist', 'assets', 'contract.json'].includes(file.name) ||
        file.name.startsWith('.env')
      )
        continue;
      const path = join(dir, file.name);
      if (file.isDirectory()) walk(path);
      else if (/\.(mjs|js|ts|json|html|css|md)$/.test(file.name) && statSync(path).size < 100000)
        files[relative(root, path).replaceAll('\\', '/')] = readFileSync(path, 'utf8');
    }
  }
  walk(root);
  return files;
}
