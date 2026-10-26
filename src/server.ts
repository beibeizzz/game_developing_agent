import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import sharp from 'sharp';
import { config, now, redact } from './config.js';
import {
  db,
  get,
  list,
  put,
  required,
  createProject,
  projectDir,
  events,
  event,
  taskUpdate,
  activeTask,
  acquire,
  release,
  recoverHost,
  uid,
} from './store.js';
import type { Task, Approval, Artifact, Project, Telemetry } from './contracts.js';
import { runProduction } from './production.js';
import { runOperations } from './operations.js';
import { registerExperiment, settleExperiment, inspectProject, metrics } from './evaluation.js';
import { proposeKnowledge, reviewKnowledge } from './memory.js';
import { docker } from './coder.js';
import { runBrowserEvaluation } from './browser-evaluation.js';
import { projectReport } from './reporting.js';

const controllers = new Map<string, AbortController>();
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
};
function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) throw new Error('请求超过 16 MiB');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function file(res: ServerResponse, path: string, download?: string) {
  if (!existsSync(path) || !statSync(path).isFile()) return json(res, { error: '文件不存在' }, 404);
  res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${download}"`);
  res.end(readFileSync(path));
}
export function launchTask(id: string, approvalId?: string) {
  const task = required<Task>('task', id);
  if (['completed', 'cancelled'].includes(task.status)) throw new Error('任务已结束，请创建新的修改任务');
  const project = required<Project>('project', task.projectId);
  if (project.archived) throw new Error('请先恢复已归档项目');
  acquire(id);
  const controller = new AbortController();
  controllers.set(id, controller);
  taskUpdate(id, { status: 'running', error: undefined });
  const run =
    task.kind === 'evaluation'
      ? runBrowserEvaluation
      : ['analysis', 'ideation'].includes(task.kind)
        ? runOperations
        : runProduction;
  void run(task, controller.signal, approvalId)
    .catch((error) => {
      const current = required<Task>('task', id);
      if (current.status !== 'cancelled')
        taskUpdate(id, {
          status: controller.signal.aborted ? 'interrupted' : 'failed',
          error: redact(String(error)).slice(0, 4000),
        });
    })
    .finally(() => {
      controllers.delete(id);
      release(id);
      // Approval made while another project ran keeps its identity and resumes once the slot is free.
      for (const waiting of list<Task>('task')) {
        if (waiting.status !== 'review' || required<Project>('project', waiting.projectId).archived) continue;
        const decision = list<Approval>('approval', waiting.projectId)
          .filter((a) => a.taskId === waiting.id)
          .at(-1);
        if (decision && decision.status !== 'pending') {
          launchTask(waiting.id, decision.id);
          break;
        }
      }
    });
  return required<Task>('task', id);
}
function newTask(projectId: string, kind: Task['kind'], instruction: string, experimentId?: string) {
  required('project', projectId);
  if (
    list<Task>('task', projectId).some(
      (t) =>
        ['queued', 'running', 'review', 'interrupted'].includes(t.status) &&
        !(kind === 'evaluation' && t.status === 'review'),
    )
  )
    throw new Error('当前项目有未结束任务，请继续或取消后再创建');
  if (activeTask()) throw new Error('当前有其他项目任务执行中');
  const task = put<Task>('task', {
    id: uid(),
    projectId,
    kind,
    instruction,
    status: 'queued',
    stage: 'queued',
    createdAt: now(),
    updatedAt: now(),
    experimentId,
  });
  event(projectId, task.id, 'task-created', { kind, instruction });
  return launchTask(task.id);
}
function snapshot(projectId: string) {
  const project = required<Project>('project', projectId);
  const builds = list<any>('build', projectId),
    previewBuild = builds.at(-1);
  return {
    project,
    tasks: list('task', projectId),
    artifacts: list('artifact', projectId),
    approvals: list('approval', projectId),
    builds,
    knowledge: list('knowledge', projectId),
    experiments: list('experiment', projectId),
    references: list('reference', projectId),
    events: events(projectId, 0, 15000).slice(-500),
    feedback: list('feedback', projectId),
    evaluations: list('evaluation', projectId),
    activeTask: activeTask(),
    previewOrigin: `http://127.0.0.1:${config.previewPort}`,
    playMetrics: previewBuild
      ? {
          human: metrics(projectId, previewBuild.id, 'human'),
          script: metrics(projectId, previewBuild.id, 'script'),
        }
      : null,
    metrics: project.currentBuild
      ? {
          human: metrics(projectId, project.currentBuild, 'human'),
          script: metrics(projectId, project.currentBuild, 'script'),
        }
      : null,
  };
}
const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || '';
    if (!['127.0.0.1', 'localhost'].includes(host.split(':')[0]))
      return json(res, { error: '仅限本地工作台' }, 403);
    const url = new URL(req.url || '/', `http://${host}`);
    const path = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';
    if (
      method !== 'GET' &&
      req.headers.origin &&
      ![
        `http://127.0.0.1:${config.port}`,
        `http://localhost:${config.port}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ].includes(req.headers.origin)
    )
      return json(res, { error: '来源校验失败' }, 403);
    if (path === '/api/status')
      return json(res, {
        configured: !!config.token,
        model: config.model,
        activeTask: activeTask(),
        version: '0.1.0',
        dataDir: config.data,
        previewPort: config.previewPort,
      });
    if (path === '/api/health') return json(res, { ok: true });
    if (path === '/api/environment') {
      let available = false;
      let image = false;
      try {
        await docker(['info', '--format', '{{.ServerVersion}}']);
        available = true;
        await docker(['image', 'inspect', config.image]);
        image = true;
      } catch {
        /* report actual state */
      }
      return json(res, { credential: !!config.token, docker: available, coderImage: image });
    }
    if (path === '/api/projects' && method === 'GET')
      return json(
        res,
        list<Project>('project').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      );
    if (path === '/api/projects' && method === 'POST') {
      const input = z
        .object({ name: z.string().trim().min(1).max(80), idea: z.string().trim().min(5).max(8000) })
        .parse(await body(req));
      return json(res, createProject(input.name, input.idea), 201);
    }
    const projectMatch = path.match(/^\/api\/projects\/([\w-]+)(?:\/(.*))?$/);
    if (projectMatch) {
      const [, projectId, action = ''] = projectMatch;
      const project = required<Project>('project', projectId);
      if (!action && method === 'GET') return json(res, snapshot(projectId));
      if (action === 'report' && method === 'GET') return json(res, projectReport(projectId));
      if (action === 'archive' && method === 'POST') {
        if (list<Task>('task', projectId).some((t) => t.status === 'running'))
          throw new Error('执行中的项目请先停止任务');
        const input = await body(req);
        return json(res, put('project', { ...project, archived: !!input.archived, updatedAt: now() }));
      }
      if (action === 'tasks' && method === 'POST') {
        const input = z
          .object({
            kind: z.enum(['production', 'iteration', 'analysis', 'ideation', 'evaluation']),
            instruction: z.string().trim().min(2).max(12000),
          })
          .parse(await body(req));
        return json(res, newTask(projectId, input.kind, input.instruction), 202);
      }
      if (action === 'references' && method === 'POST') {
        const input = z
          .object({
            title: z.string().min(1).max(100),
            note: z.string().max(3000),
            data: z.string(),
            sourceUrl: z.string().max(2000).optional(),
          })
          .parse(await body(req));
        const match = input.data.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/s);
        if (!match) throw new Error('请上传 PNG/JPEG/WebP 图片');
        const id = uid();
        mkdirSync(projectDir(projectId, 'references'), { recursive: true });
        await sharp(Buffer.from(match[2], 'base64'), { limitInputPixels: 20000000 })
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .png()
          .toFile(projectDir(projectId, 'references', id + '.png'));
        const link = `/api/projects/${projectId}/files/references/${id}.png`;
        return json(
          res,
          put('reference', {
            id,
            projectId,
            title: input.title,
            note: input.note,
            url: input.sourceUrl || link,
            imageUrl: link,
            file: 'references/' + id + '.png',
            source: 'user-local-reference',
            usage: 'design-reference-only',
            at: now(),
          }),
        );
      }
      if (action.startsWith('files/') && method === 'GET') {
        const part = action.slice(6);
        if (!/^(assets|references)\/[\w.-]+$/.test(part)) throw new Error('文件路径无效');
        return file(res, projectDir(projectId, part));
      }
      if (action.startsWith('downloads/') && method === 'GET') {
        const [, buildId, kind] = action.split('/');
        const build = required<any>('build', buildId);
        if (build.projectId !== projectId || !['source', 'web'].includes(kind))
          throw new Error('下载参数无效');
        return file(res, projectDir(projectId, 'builds', buildId, kind + '.zip'), `game-${kind}.zip`);
      }
      if (action === 'telemetry' && method === 'POST') {
        const input = z
          .object({
            buildId: z.string(),
            sessionId: z.string().min(1).max(100),
            source: z.enum(['human', 'script']),
            seed: z.number(),
            difficulty: z.string().max(40),
            kind: z.enum(['start', 'move', 'pause', 'restart', 'tick', 'game_over', 'win', 'error']),
            data: z.record(z.string(), z.unknown()),
            at: z.string().optional(),
          })
          .parse(await body(req));
        const build = required<any>('build', input.buildId);
        if (build.projectId !== projectId) throw new Error('试玩构建归属错误');
        return json(res, put<Telemetry>('telemetry', { ...input, id: uid(), projectId, at: now() }));
      }
      if (action === 'feedback' && method === 'POST') {
        const input = z
          .object({
            buildId: z.string(),
            rating: z.number().int().min(1).max(5),
            note: z.string().trim().min(1).max(6000),
          })
          .parse(await body(req));
        if (required<any>('build', input.buildId).projectId !== projectId) throw new Error('构建归属错误');
        return json(res, put('feedback', { id: uid(), projectId, ...input, source: 'human', at: now() }));
      }
      if (action === 'inspect' && method === 'POST') return json(res, inspectProject(projectId));
      if (action === 'knowledge' && method === 'POST')
        return json(res, proposeKnowledge(projectId, await body(req)));
      if (action === 'execute-proposal' && method === 'POST') {
        const { proposalId } = z.object({ proposalId: z.string() }).parse(await body(req));
        if (activeTask()) throw new Error('等待当前任务结束后执行提案');
        const experiment = registerExperiment(projectId, proposalId);
        const existing = list<Task>('task', projectId).find((t) => t.experimentId === experiment.id);
        if (existing) return json(res, existing);
        const proposal = required<Artifact>('artifact', proposalId);
        return json(res, newTask(projectId, 'iteration', proposal.data.instruction, experiment.id), 202);
      }
      if (action === 'execute-ideation' && method === 'POST') {
        const { artifactId } = z.object({ artifactId: z.string() }).parse(await body(req));
        const a = required<Artifact>('artifact', artifactId);
        if (a.projectId !== projectId || a.role !== 'ideation') throw new Error('立项产物归属无效');
        if (
          !list<Approval>('approval', projectId).some(
            (x) => x.artifactId === artifactId && x.status === 'approved',
          )
        )
          throw new Error('立项方案需审核通过');
        const prior = get<any>('ideation-launch', artifactId);
        if (prior) return json(res, prior);
        if (activeTask()) throw new Error('等待当前任务结束后启动新项目');
        const candidate = a.data.candidates[a.data.selected];
        if (!candidate) throw new Error('立项选择无效');
        const brief = [
          candidate.idea,
          '已批准的制作约束：\n' + a.data.constraints.map((x: string) => '- ' + x).join('\n'),
          '候选依据：\n' + candidate.evidence.map((x: string) => '- ' + x).join('\n'),
          '待验证问题：\n' + a.data.challenges.map((x: string) => '- ' + x).join('\n'),
          '选定理由：' + a.data.rationale,
        ].join('\n\n');
        const created = createProject(candidate.title, brief);
        const record = put('ideation-launch', {
          id: artifactId,
          projectId,
          newProjectId: created.id,
          at: now(),
        });
        event(created.id, undefined, 'project-origin', {
          sourceProject: projectId,
          artifactId,
          artifactVersion: a.version,
          selected: a.data.selected,
        });
        newTask(created.id, 'production', brief);
        return json(res, record, 201);
      }
    }
    const taskMatch = path.match(/^\/api\/tasks\/([\w-]+)\/(continue|cancel)$/);
    if (taskMatch && method === 'POST') {
      const [, id, action] = taskMatch;
      const task = required<Task>('task', id);
      if (action === 'cancel') {
        if (['completed', 'cancelled'].includes(task.status)) throw new Error('任务已结束');
        controllers.get(id)?.abort();
        return json(res, taskUpdate(id, { status: 'cancelled', error: '用户取消任务；已有产物保留。' }));
      }
      const approval =
        task.status === 'review'
          ? list<Approval>('approval', task.projectId)
              .filter((a) => a.taskId === id)
              .at(-1)
          : undefined;
      if (approval?.status === 'pending') throw new Error('请先完成当前版本的审核');
      return json(res, launchTask(id, approval?.id), 202);
    }
    const approvalMatch = path.match(/^\/api\/approvals\/([\w-]+)$/);
    if (approvalMatch && method === 'POST') {
      const input = z
        .object({
          approved: z.boolean(),
          feedback: z.string().max(6000),
          selection: z.array(z.string()).optional(),
        })
        .parse(await body(req));
      const a = required<Approval>('approval', approvalMatch[1]);
      const value = required<Artifact>('artifact', a.artifactId);
      if (a.status !== 'pending') throw new Error('该产物版本已审核');
      if (required<Task>('task', a.taskId).status !== 'review') throw new Error('任务当前未等待此审核');
      if (value.role === 'research' && input.approved && !input.selection?.length)
        throw new Error('请选择至少一个参考方向');
      if (input.selection?.some((id) => !value.data.candidates?.some((c: any) => c.id === id)))
        throw new Error('参考方向无效');
      if (!input.approved && !input.feedback.trim()) throw new Error('请填写修改意见');
      put('approval', {
        ...a,
        status: input.approved ? 'approved' : 'rejected',
        feedback: input.feedback,
        selection: input.selection,
        decidedAt: now(),
      });
      event(a.projectId, a.taskId, 'approval', {
        id: a.id,
        artifactId: a.artifactId,
        approved: input.approved,
        feedback: input.feedback,
        selection: input.selection,
      });
      if (!activeTask()) launchTask(a.taskId, a.id);
      return json(res, { saved: true, queuedForResume: !!activeTask() && activeTask() !== a.taskId });
    }
    const knowledgeMatch = path.match(/^\/api\/knowledge\/([\w-]+)\/review$/);
    if (knowledgeMatch && method === 'POST') {
      const input = z.object({ approved: z.boolean(), note: z.string() }).parse(await body(req));
      return json(res, reviewKnowledge(knowledgeMatch[1], input.approved, input.note));
    }
    const experimentMatch = path.match(/^\/api\/experiments\/([\w-]+)\/settle$/);
    if (experimentMatch && method === 'POST') {
      const input = z.object({ guardrailsPassed: z.boolean(), evidence: z.string() }).parse(await body(req));
      return json(res, settleExperiment(experimentMatch[1], input));
    }
    if (path.startsWith('/api/')) return json(res, { error: '接口不存在' }, 404);
    const webRoot = join(config.root, 'dist/workbench');
    const asset = resolve(webRoot, '.' + path);
    if (!asset.startsWith(webRoot + sep) && asset !== webRoot) return json(res, { error: '路径无效' }, 403);
    res.setHeader('Referrer-Policy', 'no-referrer');
    return file(res, existsSync(asset) && statSync(asset).isFile() ? asset : join(webRoot, 'index.html'));
  } catch (error) {
    json(res, { error: redact(error instanceof Error ? error.message : String(error)) }, 400);
  }
});

const preview = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    const match = path.match(/^\/play\/([\w-]+)\/([\w-]+)\/(.*)$/);
    if (!match) return json(res, { error: '游戏地址无效' }, 404);
    const [, projectId, buildId, part] = match;
    const build = required<any>('build', buildId);
    if (build.projectId !== projectId) throw new Error('构建归属错误');
    const root = projectDir(projectId, 'builds', buildId, 'web');
    const target = resolve(root, part || 'index.html');
    if (!target.startsWith(root + sep)) throw new Error('路径无效');
    // Games run on a separate local origin and only fetch their bundled resources.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors http://127.0.0.1:* http://localhost:*; form-action 'none'",
    );
    file(res, target);
  } catch (error) {
    json(res, { error: String(error) }, 404);
  }
});
server.listen(config.port, '127.0.0.1', () => {
  recoverHost();
  console.log(`工作台 http://127.0.0.1:${config.port}`);
});
server.on('error', (error) => {
  console.error(String(error));
  process.exitCode = 1;
  preview.close();
});
preview.listen(config.previewPort, '127.0.0.1', () =>
  console.log(`游戏预览 http://127.0.0.1:${config.previewPort}`),
);
preview.on('error', (error) => {
  console.error(String(error));
  server.close();
  process.exitCode = 1;
});
