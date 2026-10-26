import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { z } from 'zod';
import { join } from 'node:path';
import { config, now } from './config.js';
import { artifact, get, list, put, required, taskUpdate } from './store.js';
import type { Approval, Task } from './contracts.js';
import { schemas } from './contracts.js';
import { modelRole } from './model.js';
import { createBatch } from './evaluation.js';
import { sourceSnapshot } from './tools.js';

const State = Annotation.Root({
  taskId: Annotation<string>(),
  batch: Annotation<any>(),
  evidence: Annotation<any>(),
  independent: Annotation<Record<string, any>>(),
  discussion: Annotation<any>(),
  proposalId: Annotation<string>(),
  revision: Annotation<number>(),
  feedback: Annotation<string>(),
  decision: Annotation<string>(),
});
const controllers = new Map<string, AbortSignal>();
const signal = (id: string) => controllers.get(id);
const saver = SqliteSaver.fromConnString(join(config.data, 'operations-graph.sqlite'));
const responsibilities: Record<string, string> = {
  pd: '从玩法和关卡数据定位需求未落实或体验问题，引用具体批次与样本，提出可执行修改。',
  dev: '阅读真实源码、配置、接口和原始需求，定位修改文件与参数，评估实现可行性、影响范围与回归风险。',
  reviewer:
    '独立审核证据、样本口径、历史失败和数据来源。指出未经验证的因果推断，确保围绕需求完成、稳定交付与恢复。',
  analyst: '为新的躲避游戏立项建立目标与约束，引用现有试玩证据、原始目标和历史经验，标明推断。',
  gd: '在躲避游戏范围提出可执行玩法方向，明确操作与差异、实现成本和验证目标，接受证据挑战。',
};
export const operations = new StateGraph(State)
  .addNode('prepare', (s) => {
    const task = required<Task>('task', s.taskId);
    taskUpdate(task.id, { stage: 'batch-gate' });
    const batch =
      get('batch', task.id + '-batch') ||
      (task.kind === 'ideation'
        ? {
            id: task.id + '-brief',
            instruction: task.instruction,
            priorBatches: list('batch', task.projectId),
          }
        : createBatch(task.projectId, task.id));
    const buildId = batch.buildId || required<any>('project', task.projectId).currentBuild;
    const delivery = list<any>('artifact', task.projectId).find(
      (a) => a.role === 'delivery' && a.data.id === buildId,
    );
    const evidence = {
      source: sourceSnapshot(task.projectId, buildId),
      buildId,
      priorExperiments: list('experiment', task.projectId),
      design: list<any>('artifact', task.projectId).filter(
        (a) => delivery?.inputVersions.includes(a.id) && ['planner', 'level-design'].includes(a.role),
      ),
    };
    return { batch, evidence };
  })
  .addNode('independent_step', async (s) => {
    const task = required<Task>('task', s.taskId);
    taskUpdate(task.id, { stage: 'independent-analysis' });
    const specialists = task.kind === 'ideation' ? ['analyst', 'gd', 'reviewer'] : ['pd', 'dev', 'reviewer'];
    const input = { batch: s.batch, instruction: task.instruction, ...s.evidence };
    const independent: Record<string, any> = {};
    // Each role receives the same frozen evidence, and no other expert's response.
    for (const role of specialists) {
      independent[role] = await modelRole(
        task,
        role,
        responsibilities[role] + ' 此为独立阶段，形成你的独立判断。',
        input,
        schemas.expert,
        [],
        signal(task.id),
        task.id + '-' + role,
      );
      artifact(task, role, role + ' 独立分析', independent[role], [s.batch.id], task.id + '-expert-' + role);
    }
    return { independent };
  })
  .addNode('discussion_step', async (s) => {
    const task = required<Task>('task', s.taskId);
    taskUpdate(task.id, { stage: 'evidence-discussion' });
    let discussion: Record<string, any> = {};
    const rounds: Record<string, any>[] = [];
    for (let round = 0; round < 2; round++) {
      const previous = discussion;
      discussion = {};
      for (const role of Object.keys(s.independent))
        discussion[role] = await modelRole(
          task,
          role,
          responsibilities[role] +
            ' 此为讨论阶段。逐项响应其他专家的证据与质询，保留分歧，修订你的具体方案。已解决的问题从 questions 移除；仍需补证据的问题明确保留。',
          { batch: s.batch, independent: s.independent, previousDiscussion: previous, ...s.evidence },
          schemas.expert,
          [],
          signal(task.id),
          `${task.id}-discussion-${round}-${role}`,
        );
      rounds.push(discussion);
      if (!discussion.reviewer?.questions.length) break;
    }
    artifact(
      task,
      'discussion',
      '专家讨论与质询',
      { rounds, final: discussion },
      Object.keys(s.independent).map((r) => task.id + '-expert-' + r),
      task.id + '-discussion',
    );
    return { discussion: { rounds, final: discussion } };
  })
  .addNode('converge', async (s) => {
    const task = required<Task>('task', s.taskId);
    taskUpdate(task.id, { stage: 'host-convergence' });
    const isNew = task.kind === 'ideation';
    const schema = isNew ? schemas.ideation : schemas.proposal;
    const suffix = s.revision ? `-revision-${s.revision}` : '';
    const result = await modelRole(
      task,
      'host',
      isNew
        ? '主持收敛新游戏立项。候选仅限躲避类，明确约束、证据、挑战和选定理由，交给用户审核。'
        : '主持收敛为一个待审核的可证伪迭代提案。给出具体代码/参数改动、受影响角色、指标、来源、Seed、difficulty、预测区间、观察窗口、样本量、护栏和证伪条件。baseline 从同来源、同 Seed、同 difficulty 的真实数据读取；requirementsPassed 是 0–1 的通过比例；survivalSeconds 是秒。证据不足写 unresolved。knowledgeIds 仅用提供的已批准知识 ID。',
      {
        batch: s.batch,
        independent: s.independent,
        discussion: s.discussion,
        instruction: task.instruction,
        reviewFeedback: s.feedback,
        previousProposal: s.proposalId ? required<any>('artifact', s.proposalId).data : undefined,
        revisionInstruction: s.revision
          ? '依据审核反馈修订上一版，保留冻结证据和未受影响的决定；明确解决已获得答案的问题。再次提交完整结构化方案。'
          : undefined,
        knowledge: list<any>('knowledge', task.projectId).filter((k) => k.status === 'approved'),
      },
      schema as z.ZodType<any>,
      [],
      signal(task.id),
      task.id + '-host' + suffix,
      (result: any) => {
        if (isNew) {
          if (!result.candidates[result.selected]) throw new Error('selected 超出实际候选范围');
          return;
        }
        const valid = new Set(
          list<any>('knowledge', task.projectId)
            .filter((k) => k.status === 'approved')
            .map((k) => k.id),
        );
        if (result.knowledgeIds.some((id: string) => !valid.has(id))) throw new Error('提案引用未知知识版本');
        if (result.targetMin > result.targetMax) throw new Error('预测区间应满足 targetMin ≤ targetMax');
        if (result.metric === 'requirementsPassed' && (result.targetMin < 0 || result.targetMax > 1))
          throw new Error('requirementsPassed 的预测区间应位于 0–1');
        const cohort = s.batch.cohorts?.find(
          (c: any) =>
            c.source === result.source && c.seed === result.seed && c.difficulty === result.difficulty,
        );
        const observations = cohort?.[result.metric];
        if (!observations?.length)
          throw new Error('所选来源、Seed、难度与指标缺少基线样本，请选择 batch.cohorts 内已有观测。');
        result.baseline = observations.reduce((a: number, b: number) => a + b, 0) / observations.length;
      },
    );
    const value = artifact(
      task,
      isNew ? 'ideation' : 'proposal',
      result.title,
      result,
      [task.id + '-discussion', s.batch.id, ...(s.proposalId ? [s.proposalId] : [])],
      task.id + '-proposal' + suffix,
    );
    return { proposalId: value.id };
  })
  .addNode('review', (s) => {
    signal(s.taskId)?.throwIfAborted();
    const task = required<Task>('task', s.taskId);
    const id = s.proposalId + '-review';
    if (!get('approval', id))
      put<Approval>('approval', {
        id,
        projectId: task.projectId,
        taskId: task.id,
        artifactId: s.proposalId,
        status: 'pending',
        feedback: '',
        createdAt: now(),
      });
    taskUpdate(task.id, { status: 'review', stage: 'proposal-review' });
    const decision = interrupt({ approvalId: id, artifactId: s.proposalId });
    const saved = required<Approval>('approval', id);
    if (decision.approvalId !== id || saved.status === 'pending') throw new Error('提案审核版本不一致');
    if (saved.status === 'rejected') {
      taskUpdate(task.id, { status: 'running', stage: 'proposal-revision' });
      return { decision: saved.status, feedback: saved.feedback, revision: (s.revision || 0) + 1 };
    }
    taskUpdate(task.id, { status: 'completed', stage: saved.status });
    return { decision: saved.status };
  })
  .addEdge(START, 'prepare')
  .addEdge('prepare', 'independent_step')
  .addEdge('independent_step', 'discussion_step')
  .addEdge('discussion_step', 'converge')
  .addEdge('converge', 'review')
  .addConditionalEdges('review', (s) => (s.decision === 'rejected' ? 'converge' : END), ['converge', END])
  .compile({ checkpointer: saver });

export async function runOperations(task: Task, abort: AbortSignal, approvalId?: string) {
  controllers.set(task.id, abort);
  const settings = { configurable: { thread_id: task.id }, recursionLimit: 40 };
  try {
    const snapshot = await operations.getState(settings);
    await operations.invoke(
      approvalId
        ? new Command({ resume: { approvalId } })
        : Object.keys(snapshot.values || {}).length
          ? null
          : { taskId: task.id },
      settings,
    );
  } finally {
    controllers.delete(task.id);
  }
}
