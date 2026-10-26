import { createHash } from 'node:crypto';
import { db, list, get, required, put, uid, event } from './store.js';
import { now } from './config.js';
import type { Experiment, Project, Telemetry } from './contracts.js';
import { proposeKnowledge } from './memory.js';

export function metrics(
  projectId: string,
  buildId: string,
  source: 'human' | 'script',
  seed?: number,
  difficulty?: string,
) {
  const telemetry = list<Telemetry>('telemetry', projectId).filter(
    (e) =>
      e.buildId === buildId &&
      e.source === source &&
      (seed === undefined || e.seed === seed) &&
      (difficulty === undefined || (e.difficulty || 'normal') === difficulty),
  );
  const sessions = new Map<string, Telemetry[]>();
  for (const e of telemetry) sessions.set(e.sessionId, [...(sessions.get(e.sessionId) || []), e]);
  const completed = [...sessions.values()].filter(
    (es) => es.some((e) => e.kind === 'start') && es.some((e) => ['game_over', 'win'].includes(e.kind)),
  );
  const survival = completed
    .map((es) => Number(es.findLast((e) => ['game_over', 'win'].includes(e.kind))?.data.survivalSeconds))
    .filter(Number.isFinite);
  const evaluations = list<any>('evaluation', projectId).filter(
    (e) =>
      e.buildId === buildId &&
      e.source === source &&
      (seed === undefined || e.seed === seed) &&
      (difficulty === undefined || (e.difficulty || 'normal') === difficulty),
  );
  return {
    source,
    seed,
    difficulty,
    buildId,
    sessions: sessions.size,
    completedSessions: completed.length,
    survivalSeconds: survival,
    requirementsPassed: evaluations.map((e) => e.passed / Math.max(1, e.total)),
    errors: telemetry.filter((e) => e.kind === 'error').length,
    eventIds: telemetry.map((e) => e.id),
    evaluationIds: evaluations.map((e) => e.id),
  };
}
export function createBatch(projectId: string, taskId: string) {
  const project = required<Project>('project', projectId);
  if (!project.currentBuild) throw new Error('数据门禁：需要已批准的游戏构建');
  const data = {
    buildId: project.currentBuild,
    human: metrics(projectId, project.currentBuild, 'human'),
    script: metrics(projectId, project.currentBuild, 'script'),
    feedback: list<any>('feedback', projectId).filter((f) => f.buildId === project.currentBuild),
    evaluations: list<any>('evaluation', projectId).filter((e) => e.buildId === project.currentBuild),
  };
  if (!data.human.completedSessions && !data.script.completedSessions && !data.evaluations.length)
    throw new Error('数据门禁：请先完成一局试玩或脚本测评');
  const observations = [...list<any>('telemetry', projectId), ...data.evaluations].filter(
    (e) => e.buildId === project.currentBuild,
  );
  const groups = new Map(
    observations.map((e) => [
      JSON.stringify([e.source, e.seed, e.difficulty || 'normal']),
      { source: e.source, seed: e.seed, difficulty: e.difficulty || 'normal' },
    ]),
  );
  const cohorts = [...groups.values()].map((c) =>
    metrics(projectId, project.currentBuild!, c.source, c.seed, c.difficulty),
  );
  const batch = {
    id: taskId + '-batch',
    projectId,
    ...data,
    cohorts,
    at: now(),
    hash: createHash('sha256')
      .update(JSON.stringify({ ...data, cohorts }))
      .digest('hex'),
  };
  put('batch', batch);
  event(projectId, taskId, 'batch', { id: batch.id, hash: batch.hash });
  return batch;
}
export function registerExperiment(projectId: string, proposalId: string): Experiment {
  const a = required<any>('artifact', proposalId);
  if (a.projectId !== projectId || a.role !== 'proposal') throw new Error('提案归属无效');
  const approval = list<any>('approval', projectId).find(
    (x) => x.artifactId === proposalId && x.status === 'approved',
  );
  if (!approval) throw new Error('提案需先审核通过');
  const existing = list<Experiment>('experiment', projectId).find((e) => e.proposalId === proposalId);
  if (existing) return existing;
  const proposal = a.data;
  const project = required<Project>('project', projectId);
  if (!project.currentBuild) throw new Error('基线构建缺失');
  const batch = (a.inputVersions || []).map((id: string) => get<any>('batch', id)).find(Boolean);
  if (batch && batch.buildId !== project.currentBuild)
    throw new Error('当前构建已变化，请针对新基线重新分析提案');
  const data = batch
    ? batch.cohorts?.find(
        (c: any) =>
          c.source === proposal.source &&
          c.seed === proposal.seed &&
          c.difficulty === (proposal.difficulty || 'normal'),
      )
    : metrics(
        projectId,
        project.currentBuild,
        proposal.source,
        proposal.seed,
        proposal.difficulty || 'normal',
      );
  if (!data) throw new Error('冻结批次缺少所选基线口径，请重新分析');
  const values = data[proposal.metric as 'survivalSeconds' | 'requirementsPassed'];
  if (!values.length) throw new Error('所选数据来源与 Seed 缺少基线观测');
  if (proposal.targetMax < proposal.targetMin) throw new Error('预测区间无效');
  const experiment = put<Experiment>('experiment', {
    id: uid(),
    projectId,
    proposalId,
    baselineBuild: project.currentBuild,
    baseline: average(values),
    targetMin: proposal.targetMin,
    targetMax: proposal.targetMax,
    metric: proposal.metric,
    source: proposal.source,
    seed: proposal.seed,
    difficulty: proposal.difficulty || 'normal',
    minSamples: proposal.minSamples,
    windowMinutes: proposal.windowMinutes,
    openedAt: now(),
    status: 'registered',
    baselineEvidence: { batchId: batch?.id, eventIds: data.eventIds, evaluationIds: data.evaluationIds },
    guardrails: proposal.guardrails,
    falsification: proposal.falsification,
    knowledgeIds: proposal.knowledgeIds,
  });
  event(projectId, undefined, 'experiment-registered', experiment);
  return experiment;
}
const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const settleExperiment = db.transaction(
  (id: string, review?: { guardrailsPassed: boolean; evidence: string }) => {
    const experiment = required<Experiment>('experiment', id);
    if (experiment.status === 'settled') return experiment;
    if (!experiment.candidateBuild || !experiment.candidateAt)
      return { ...experiment, pendingReason: '候选构建待完成' };
    if (Date.now() < Date.parse(experiment.candidateAt) + experiment.windowMinutes * 60_000)
      return { ...experiment, pendingReason: '观察窗口尚未结束' };
    const data = metrics(
      experiment.projectId,
      experiment.candidateBuild,
      experiment.source,
      experiment.seed,
      experiment.difficulty || 'normal',
    );
    const values = data[experiment.metric];
    if (!review?.evidence?.trim() && experiment.guardrails.length)
      return { ...experiment, pendingReason: '请填写护栏核对结果和证据' };
    let classification = 'insufficient';
    let mean: number | null = null;
    if (values.length >= experiment.minSamples) {
      mean = average(values);
      const hit = mean >= experiment.targetMin && mean <= experiment.targetMax;
      const guardrails = data.errors === 0 && (!experiment.guardrails.length || review?.guardrailsPassed);
      classification = hit ? (guardrails ? 'positive' : 'mixed') : 'negative';
    }
    const settlement = {
      classification,
      mean,
      samples: values.length,
      baseline: experiment.baseline,
      observed: values,
      delta: mean === null ? null : mean - experiment.baseline,
      data,
      guardrailReview: review || null,
      at: now(),
      limitation: '本地同来源、同 Seed 的个案前后对照；人工熟悉效应与小样本限制仍需考虑。',
    };
    const result = put('experiment', { ...experiment, status: 'settled', settlement });
    event(experiment.projectId, undefined, 'settlement', { id, ...settlement });
    const proposal = required<any>('artifact', experiment.proposalId).data;
    proposeKnowledge(experiment.projectId, {
      action: 'add',
      title: `${proposal.title}：${classification}`,
      content: `${proposal.diagnosis}\n观测结论：${classification}；指标 ${experiment.metric}。详见实验 ${id}。`,
      evidence: [id, experiment.proposalId],
      counterEvidence: ['negative', 'mixed'].includes(classification) ? [id] : [],
      tags: ['dodge', experiment.metric],
      limitations: settlement.limitation,
      confidence: classification === 'insufficient' ? 'insufficient' : 'case-observation',
    });
    for (const knowledgeId of experiment.knowledgeIds) {
      const k = get<any>('knowledge', knowledgeId);
      if (k && ['negative', 'mixed'].includes(classification))
        proposeKnowledge(experiment.projectId, {
          ...k,
          action: 'revise',
          previousId: k.id,
          content: k.content + `\n待核对反证：实验 ${id} 为 ${classification}。`,
          evidence: [...k.evidence, id],
          counterEvidence: [...k.counterEvidence, id],
          confidence: 'challenged',
        });
    }
    return result;
  },
);
export function inspectProject(projectId: string) {
  const tasks = list<any>('task', projectId);
  const approvals = list<any>('approval', projectId).filter((a) => a.status === 'pending');
  const experiments = list<Experiment>('experiment', projectId).filter((e) => e.status !== 'settled');
  const result = {
    id: uid(),
    projectId,
    at: now(),
    interruptedTasks: tasks.filter((t) => ['failed', 'interrupted'].includes(t.status)).map((t) => t.id),
    pendingApprovals: approvals.map((a) => a.id),
    dueExperiments: experiments
      .filter((e) => e.candidateAt && Date.now() >= Date.parse(e.candidateAt) + e.windowMinutes * 60000)
      .map((e) => e.id),
    pendingKnowledge: list<any>('knowledge', projectId)
      .filter((k) => k.status === 'pending')
      .map((k) => k.id),
    ideationReconciliation: list<any>('ideation-launch', projectId).map((launch) => {
      const project = get<Project>('project', launch.newProjectId);
      return {
        artifactId: launch.id,
        newProjectId: launch.newProjectId,
        currentBuild: project?.currentBuild || null,
        tasks: list<any>('task', launch.newProjectId).map((t) => ({
          id: t.id,
          status: t.status,
          stage: t.stage,
        })),
        outcome: project?.currentBuild ? 'approved-delivery' : 'awaiting-delivery',
      };
    }),
    priority: ['settle-due-experiments', 'recover-delivery', 'review-proposals', 'new-analysis'],
  };
  put('inspection', result);
  event(projectId, undefined, 'inspection', result);
  return result;
}
