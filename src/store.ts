import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { mkdirSync } from 'node:fs';
import { config, now, redact } from './config.js';
import type { Artifact, Approval, Task, Project } from './contracts.js';

export const db = new Database(join(config.data, 'workbench.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, project TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE INDEX IF NOT EXISTS records_project ON records(kind,project);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, task TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS execution_lock (id INTEGER PRIMARY KEY CHECK(id=1), task TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO migrations VALUES(1);`);
export const uid = () => randomUUID();
export function put<T extends { id: string; projectId?: string }>(kind: string, item: T): T {
  db.prepare(
    'INSERT INTO records(kind,id,project,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET project=excluded.project, body=excluded.body',
  ).run(kind, item.id, item.projectId || (kind === 'project' ? item.id : ''), JSON.stringify(item));
  return item;
}
export function get<T = any>(kind: string, id: string): T | undefined {
  const row = db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind, id) as any;
  return row ? JSON.parse(row.body) : undefined;
}
export function required<T = any>(kind: string, id: string): T {
  const value = get<T>(kind, id);
  if (!value) throw new Error(`${kind} 不存在：${id}`);
  return value;
}
export function list<T = any>(kind: string, project?: string): T[] {
  const rows =
    project === undefined
      ? db.prepare('SELECT body FROM records WHERE kind=? ORDER BY rowid').all(kind)
      : db.prepare('SELECT body FROM records WHERE kind=? AND project=? ORDER BY rowid').all(kind, project);
  return rows.map((r: any) => JSON.parse(r.body));
}
export function event(projectId: string, taskId: string | undefined, kind: string, data: any) {
  const at = now();
  const body = redact(JSON.stringify(data));
  const result = db
    .prepare('INSERT INTO events(project,task,kind,body,at) VALUES(?,?,?,?,?)')
    .run(projectId, taskId || null, kind, body, at);
  return { seq: Number(result.lastInsertRowid), projectId, taskId, kind, data: JSON.parse(body), at };
}
export function events(project: string, after = 0, limit = 500) {
  return (
    db
      .prepare('SELECT * FROM events WHERE project=? AND seq>? ORDER BY seq LIMIT ?')
      .all(project, after, limit) as any[]
  ).map((r) => ({
    seq: r.seq,
    projectId: r.project,
    taskId: r.task,
    kind: r.kind,
    data: JSON.parse(r.body),
    at: r.at,
  }));
}
export function projectDir(projectId: string, ...parts: string[]) {
  if (!/^[\w-]+$/.test(projectId)) throw new Error('项目标识无效');
  const root = join(config.data, 'projects', projectId);
  mkdirSync(root, { recursive: true });
  const path = resolve(root, ...parts);
  if (path !== root && !path.startsWith(root + sep)) throw new Error('路径越界');
  return path;
}
export function taskUpdate(id: string, changes: Partial<Task>) {
  const task = put('task', { ...required<Task>('task', id), ...changes, updatedAt: now() });
  event(task.projectId, id, 'task', { status: task.status, stage: task.stage, error: task.error });
  return task;
}
export const acquire = db.transaction((taskId: string) => {
  const lock = db.prepare('SELECT task FROM execution_lock WHERE id=1').get() as any;
  if (lock) throw new Error(`另一个任务正在执行：${lock.task}`);
  db.prepare('INSERT INTO execution_lock VALUES(1,?)').run(taskId);
});
export const release = (taskId: string) =>
  db.prepare('DELETE FROM execution_lock WHERE id=1 AND task=?').run(taskId);
export const activeTask = () =>
  (db.prepare('SELECT task FROM execution_lock WHERE id=1').get() as any)?.task as string | undefined;
export function recoverHost() {
  // One workbench process owns this database; HTTP bind prevents a second server from recovering it.
  for (const task of list<Task>('task'))
    if (task.status === 'running')
      taskUpdate(task.id, { status: 'interrupted', error: '工作台重启；继续时将核对容器与已有产物。' });
  db.prepare('DELETE FROM execution_lock').run();
}
export function artifact(
  task: Task,
  role: string,
  title: string,
  data: any,
  inputVersions: string[],
  stableId?: string,
): Artifact {
  if (stableId && get('artifact', stableId)) return required('artifact', stableId);
  const version = list<Artifact>('artifact', task.projectId).filter((a) => a.role === role).length + 1;
  const value = put<Artifact>('artifact', {
    id: stableId || uid(),
    projectId: task.projectId,
    taskId: task.id,
    role,
    title,
    data,
    inputVersions,
    version,
    createdAt: now(),
  });
  event(task.projectId, task.id, 'artifact', { id: value.id, role, version, title });
  return value;
}
export function approvedArtifacts(project: string): Record<string, Artifact> {
  const approved = new Set(
    list<Approval>('approval', project)
      .filter((a) => a.status === 'approved')
      .map((a) => a.artifactId),
  );
  const result: Record<string, Artifact> = {};
  for (const a of list<Artifact>('artifact', project))
    if (approved.has(a.id) || ['producer', 'game', 'level-code', 'audio'].includes(a.role))
      result[a.role] = a;
  return result;
}
export function createProject(name: string, idea: string) {
  const project: Project = { id: uid(), name, idea, createdAt: now(), updatedAt: now(), archived: false };
  return put('project', project);
}
