import { db, list } from './store.js';
import { now } from './config.js';
import type { Task, Job } from './contracts.js';

/** Durations come from persisted transitions; model usage retains provider units. */
export function projectReport(projectId: string, asOf = now()) {
  const rows = db
    .prepare('SELECT task,kind,body,at FROM events WHERE project=? ORDER BY seq')
    .all(projectId) as any[];
  const records = rows.map((row) => ({ ...row, data: JSON.parse(row.body) }));
  const tasks = list<Task>('task', projectId).map((task) => {
    const events = records.filter((e) => e.task === task.id);
    const transitions = events.filter((e) => e.kind === 'task');
    const end = ['completed', 'cancelled'].includes(task.status)
      ? Date.parse(task.updatedAt)
      : Date.parse(asOf);
    const durations: Record<string, number> = {};
    for (let i = 0; i < transitions.length; i++) {
      const current = transitions[i];
      const duration = Math.max(
        0,
        Math.min(end, Date.parse(transitions[i + 1]?.at || asOf)) - Date.parse(current.at),
      );
      durations[current.data.status] = (durations[current.data.status] || 0) + duration;
    }
    const seen = new Set<string>();
    const model = events
      .filter((e) => e.kind === 'model-usage')
      .filter((e) => {
        const key = e.data.responseId;
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e) => ({ at: e.at, ...e.data }));
    const media = events.filter((e) => e.kind === 'media-usage').map((e) => ({ at: e.at, ...e.data }));
    const jobs = list<Job>('job', projectId)
      .filter((j) => j.taskId === task.id)
      .map((j) => ({
        id: j.id,
        role: j.role,
        status: j.status,
        sessionId: j.sessionId,
        usage: j.result?.usage,
        durationMs: j.result?.durationMs,
      }));
    return {
      taskId: task.id,
      kind: task.kind,
      status: task.status,
      stage: task.stage,
      wallMs: Math.max(0, end - Date.parse(task.createdAt)),
      stateDurationsMs: durations,
      modelRequests: model.length,
      modelAttempts: events.filter((e) => ['model-start', 'model-retry'].includes(e.kind)).length,
      toolCalls: events.filter((e) => e.kind === 'tool-start').length,
      reviewDecisions: events.filter((e) => e.kind === 'approval').map((e) => ({ at: e.at, ...e.data })),
      failures: events
        .filter(
          (e) =>
            e.kind === 'tool-error' ||
            e.kind === 'model-retry' ||
            e.kind === 'model-output-invalid' ||
            (e.kind === 'task' && ['failed', 'interrupted'].includes(e.data.status)),
        )
        .map((e) => ({ at: e.at, ...e.data })),
      modelUsage: model,
      mediaUsage: media,
      codingJobs: jobs,
    };
  });
  return {
    projectId,
    asOf,
    tasks,
    units:
      'Durations in milliseconds; raw usage is reported by providers. AFP and invoiced charges require provider billing records.',
    evidence: 'SQLite event transitions, provider responses and stable coding job records',
  };
}
