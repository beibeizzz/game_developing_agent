import { z } from 'zod';

export const roles = ['research', 'planner', 'art', 'audio', 'game', 'level-design', 'level-code'] as const;
export type Role = (typeof roles)[number];
export const roleLabels: Record<Role, string> = {
  research: '玩法调研',
  planner: '策划',
  art: '美术',
  audio: '音频',
  game: '游戏编码',
  'level-design': '关卡设计',
  'level-code': '关卡编码',
};
export type Status = 'queued' | 'running' | 'review' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface Project {
  id: string;
  name: string;
  idea: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  currentBuild?: string;
}
export interface Task {
  id: string;
  projectId: string;
  kind: 'production' | 'iteration' | 'analysis' | 'ideation' | 'evaluation';
  instruction: string;
  status: Status;
  stage: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  experimentId?: string;
}
export interface Artifact {
  id: string;
  projectId: string;
  taskId: string;
  role: string;
  version: number;
  title: string;
  data: any;
  inputVersions: string[];
  createdAt: string;
}
export interface Approval {
  id: string;
  projectId: string;
  taskId: string;
  artifactId: string;
  status: 'pending' | 'approved' | 'rejected';
  feedback: string;
  selection?: string[];
  createdAt: string;
  decidedAt?: string;
}
export interface Job {
  id: string;
  projectId: string;
  taskId: string;
  role: string;
  status: Status;
  result?: any;
  error?: string;
  container?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Knowledge {
  id: string;
  projectId: string;
  title: string;
  content: string;
  tags: string[];
  scope: 'production' | 'operations';
  action: 'add' | 'revise' | 'retire';
  previousId?: string;
  status: 'pending' | 'approved' | 'rejected' | 'retired';
  version: number;
  evidence: string[];
  counterEvidence: string[];
  confidence: string;
  limitations: string;
  createdAt: string;
  reviewNote?: string;
}
export interface Telemetry {
  id: string;
  projectId: string;
  buildId: string;
  sessionId: string;
  source: 'human' | 'script';
  seed: number;
  difficulty: string;
  kind: string;
  data: Record<string, unknown>;
  at: string;
}
export interface Experiment {
  id: string;
  projectId: string;
  proposalId: string;
  baselineBuild: string;
  candidateBuild?: string;
  baseline: number;
  baselineEvidence?: { batchId?: string; eventIds: string[]; evaluationIds: string[] };
  targetMin: number;
  targetMax: number;
  metric: 'survivalSeconds' | 'requirementsPassed';
  source: 'human' | 'script';
  seed: number;
  difficulty?: string;
  minSamples: number;
  windowMinutes: number;
  openedAt: string;
  candidateAt?: string;
  status: 'registered' | 'observing' | 'settled';
  guardrails: string[];
  falsification: string;
  knowledgeIds: string[];
  settlement?: any;
}

const requirement = z.object({ id: z.string(), description: z.string(), acceptance: z.string() });
// Real expert output used punctuation placeholders in otherwise valid JSON.
// Empty optional lists are meaningful; each supplied entry must carry content.
const expertText = z.string().regex(/[\p{L}\p{N}]/u, '填写具体内容；无条目时使用空数组，单个标点占位无效');

export const schemas = {
  producer: z.object({
    intent: z.enum(['create', 'modify', 'consult']),
    summary: z.string(),
    roles: z.array(z.enum(roles)),
    reason: z.string(),
    assumptions: z.array(z.string()),
  }),
  research: z.object({
    summary: z.string(),
    candidates: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
          imageUrl: z.string(),
          mechanics: z.string(),
          artDirection: z.string(),
        }),
      )
      .min(2)
      .max(5),
    sources: z.array(z.string()),
    recommendation: z.string(),
  }),
  planner: z.object({
    title: z.string(),
    summary: z.string(),
    controls: z.record(z.string(), z.string()),
    requirements: z.array(requirement).min(3),
    entities: z.array(z.object({ id: z.string(), behavior: z.string(), size: z.string() })),
    rules: z.array(z.string()),
    artStyle: z.string(),
    assets: z.array(
      z.object({ id: z.string(), kind: z.enum(['image', 'procedural']), description: z.string() }),
    ),
    audio: z.array(
      z.object({
        id: z.string(),
        category: z.enum(['bgm', 'interaction', 'state', 'ui', 'voice']),
        description: z.string(),
      }),
    ),
    levelInterface: z.string(),
    difficulty: z.array(z.string()),
    dimensions: z.object({ width: z.number(), height: z.number() }),
  }),
  art: z.object({
    summary: z.string(),
    assets: z.array(
      z.object({ id: z.string(), file: z.string(), purpose: z.string(), references: z.array(z.string()) }),
    ),
    layout: z.array(
      z.object({ id: z.string(), x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    ),
    frameFile: z.string(),
    visualAnalysis: z.string(),
  }),
  audio: z.object({
    summary: z.string(),
    assets: z
      .array(
        z.object({
          id: z.string(),
          file: z.string(),
          category: z.enum(['bgm', 'interaction', 'state', 'ui', 'voice']),
          source: z.string(),
          trigger: z.string(),
          loop: z.boolean(),
        }),
      )
      .min(1),
  }),
  'level-design': z.object({
    gameType: z.literal('dodge'),
    dataStructure: z.string(),
    production: z.object({
      mode: z.enum(['runtime', 'prebuilt']),
      algorithm: z.string(),
      parameters: z.record(z.string(), z.any()),
      seeds: z.array(z.number()),
    }),
    validation: z.object({
      method: z.string(),
      assumptions: z.array(z.string()),
      retries: z.number().int().min(0).max(5),
    }),
    difficultyCurve: z.array(z.object({ name: z.string(), description: z.string(), factor: z.number() })),
  }),
  expert: z.object({
    summary: expertText,
    observations: z.array(expertText),
    evidence: z.array(expertText),
    hypothesis: expertText,
    changes: z.array(z.object({ file: expertText, change: expertText })),
    risks: z.array(expertText),
    questions: z.array(expertText),
  }),
  proposal: z.object({
    title: z.string(),
    diagnosis: z.string(),
    evidence: z.array(z.string()),
    instruction: z.string(),
    affectedRoles: z.array(z.enum(roles)),
    metric: z.enum(['survivalSeconds', 'requirementsPassed']),
    source: z.enum(['human', 'script']),
    seed: z.number().int(),
    difficulty: z.enum(['easy', 'normal', 'hard']).default('normal'),
    baseline: z.number(),
    targetMin: z.number(),
    targetMax: z.number(),
    minSamples: z.number().int().min(1),
    windowMinutes: z.number().min(0),
    guardrails: z.array(z.string()),
    falsification: z.string(),
    unresolved: z.array(z.string()),
    knowledgeIds: z.array(z.string()),
  }),
  ideation: z.object({
    title: z.string(),
    constraints: z.array(z.string()),
    candidates: z
      .array(z.object({ title: z.string(), idea: z.string(), evidence: z.array(z.string()) }))
      .min(2),
    selected: z.number().int().min(0),
    challenges: z.array(z.string()),
    rationale: z.string(),
  }),
};
