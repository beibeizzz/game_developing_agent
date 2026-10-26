import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, now } from './config.js';
import { event, get, list, put, required, uid, events } from './store.js';
import type { Knowledge, Task } from './contracts.js';

export function contextFor(task: Task, role: string) {
  const scope = ['host', 'pd', 'dev', 'reviewer', 'analyst', 'gd'].includes(role)
    ? 'operations'
    : 'production';
  const directory = list<Knowledge>('knowledge', task.projectId).filter((k) => k.status === 'approved');
  const query = (task.instruction + ' ' + role + ' dodge').toLowerCase();
  const chosen = directory
    .map((k) => ({
      k,
      score:
        (k.scope === scope ? 2 : 0) +
        k.tags.filter((t) => t.trim() && query.includes(t.toLowerCase())).length * 3,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const history = events(task.projectId, 0, 10000)
    .filter((e) => ['artifact', 'settlement', 'task', 'knowledge-review'].includes(e.kind))
    .slice(-24);
  const memory = {
    core: readFileSync(join(config.root, 'prompts/core.md'), 'utf8'),
    handbook: readFileSync(join(config.root, 'prompts', scope + '.md'), 'utf8'),
    knowledgeDirectory: directory.map((k) => ({
      id: k.id,
      title: k.title,
      tags: k.tags,
      version: k.version,
      scope: k.scope,
    })),
    knowledge: chosen.map(({ k, score }) => ({ ...k, matchScore: score })),
    history,
    session: { taskId: task.id, role, instruction: task.instruction },
  };
  event(task.projectId, task.id, 'memory-read', {
    role,
    handbook: scope,
    knowledgeIds: chosen.map((x) => x.k.id),
    historyEventIds: history.map((e) => e.seq),
  });
  return memory;
}
export function proposeKnowledge(projectId: string, input: Partial<Knowledge>) {
  const previous = input.previousId ? required<Knowledge>('knowledge', input.previousId) : undefined;
  if (previous && previous.projectId !== projectId) throw new Error('知识项目不一致');
  if ((input.action || 'add') !== 'add' && !previous) throw new Error('修订或退役需要已有知识版本');
  if (!input.title?.trim() || !input.content?.trim() || !input.evidence?.length)
    throw new Error('知识需要标题、正文和证据');
  return put<Knowledge>('knowledge', {
    id: uid(),
    projectId,
    title: input.title,
    content: input.content,
    tags: input.tags || ['dodge'],
    scope: input.scope || 'operations',
    action: input.action || 'add',
    previousId: previous?.id,
    status: 'pending',
    version: (previous?.version || 0) + 1,
    evidence: input.evidence,
    counterEvidence: input.counterEvidence || [],
    confidence: input.confidence || 'case-observation',
    limitations: input.limitations || '当前项目与已记录样本范围内的观察',
    createdAt: now(),
  });
}
export function reviewKnowledge(id: string, approved: boolean, note: string) {
  const item = required<Knowledge>('knowledge', id);
  if (item.status !== 'pending') throw new Error('知识已处理');
  if (approved && item.previousId) {
    const prior = required<Knowledge>('knowledge', item.previousId);
    if (prior.status !== 'approved') throw new Error('前一版本已变化，请重新提交知识修订');
    put('knowledge', { ...prior, status: 'retired' });
  }
  const result = put('knowledge', {
    ...item,
    status: approved ? (item.action === 'retire' ? 'retired' : 'approved') : 'rejected',
    reviewNote: note,
  });
  event(item.projectId, undefined, 'knowledge-review', { id, status: result.status, note });
  return result;
}
