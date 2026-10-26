import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import OperationsPanel from './OperationsPanel.js';

type Any = Record<string, any>;
const labels: Record<string, string> = {
  research: '玩法调研',
  planner: '策划方案',
  art: '美术制作',
  audio: '声音设计',
  game: '游戏编码',
  'level-design': '关卡方案',
  'level-code': '关卡编码',
  producer: '制作计划',
  delivery: '游戏交付',
  proposal: '迭代提案',
  ideation: '新游戏立项',
  pd: '玩法分析',
  dev: '开发评估',
  reviewer: '证据评审',
  discussion: '专家讨论',
  analyst: '立项分析',
  gd: '游戏设计',
  host: '主持收敛',
  'batch-gate': '核对分析数据',
  'independent-analysis': '专家独立分析',
  'evidence-discussion': '专家讨论与质询',
  'host-convergence': '汇总迭代方案',
  'proposal-review': '审核迭代方案',
  'proposal-revision': '根据审核意见修订方案',
  'evaluation-complete': '游戏验证完成',
};
const statuses: Record<string, string> = {
  running: '正在执行',
  review: '等待你审核',
  completed: '已完成',
  failed: '执行失败',
  interrupted: '可以恢复',
  cancelled: '已取消',
  queued: '准备开始',
  approved: '已批准',
  rejected: '需修改',
  pending: '待审核',
  registered: '已预登记',
  observing: '观察中',
  settled: '已结算',
  positive: '预测命中',
  negative: '预测未命中',
  mixed: '命中但护栏未通过',
  insufficient: '证据不足',
};
const stages = ['research', 'planner', 'art', 'audio', 'game', 'level-design', 'level-code', 'delivery'];
const stageLabel = (stage: string) =>
  labels[stage] || statuses[stage] || (stage.startsWith('evaluation:') ? '验证游戏' : stage);
const pretty = (value: any) => JSON.stringify(value, null, 2);
const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
async function api(path: string, data?: any) {
  const response = await fetch(
    '/api' + path,
    data === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}
function Pill({ value }: { value: string }) {
  return <span className={'pill ' + value}>{statuses[value] || value}</span>;
}
function JsonView({ data }: { data: any }) {
  return <pre className="json-view">{pretty(data)}</pre>;
}
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <span className="icon" aria-hidden="true">
      {children}
    </span>
  );
}
const taskHints: Record<string, string> = {
  production: '从创意开始，依次准备调研、策划、美术、编码和试玩版本。关键方案需审核。',
  iteration: '直接修改当前游戏。写明目标和需要保留的玩法，制作团队会规划涉及的角色。',
  analysis: '分析当前游戏的试玩与测评，生成待审核的迭代提案。批准提案后可登记实验并执行修改。',
  ideation: '结合已有经验提出新游戏候选。审核立项后，再创建独立项目并开始制作。',
};
const taskNames: Record<string, string> = {
  production: '创意制作',
  iteration: '修改游戏',
  analysis: '试玩分析',
  ideation: '新游戏立项',
  evaluation: '验证游戏',
};
function CreateDialog({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="create-dialog"
      aria-labelledby="create-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function App() {
  const [projects, setProjects] = useState<Any[]>([]),
    [status, setStatus] = useState<Any>({});
  const [projectId, setProjectId] = useState(location.hash.slice(1)),
    [snapshot, setSnapshot] = useState<Any | null>(null);
  const [tab, setTab] = useState('classic'),
    [selected, setSelected] = useState('');
  const [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false),
    [name, setName] = useState(''),
    [idea, setIdea] = useState('');
  const [instruction, setInstruction] = useState(''),
    [kind, setKind] = useState('production');
  const [reviewNote, setReviewNote] = useState(''),
    [selection, setSelection] = useState<string[]>([]);
  const [feedback, setFeedback] = useState(''),
    [rating, setRating] = useState(4);
  const [showArchived, setShowArchived] = useState(false),
    [zoom, setZoom] = useState(1);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const latest =
    snapshot?.tasks?.find((t: Any) => t.id === status.activeTask) ||
    snapshot?.tasks?.findLast((t: Any) => t.status === 'review') ||
    snapshot?.tasks?.at(-1);
  const active =
    latest && ['running', 'review', 'interrupted', 'failed', 'queued'].includes(latest.status)
      ? latest
      : undefined;
  const pending =
    snapshot?.approvals?.filter(
      (a: Any) =>
        a.status === 'pending' && snapshot.tasks.find((t: Any) => t.id === a.taskId)?.status === 'review',
    ) || [];
  const focus =
    snapshot?.artifacts?.find((a: Any) => a.id === selected) ||
    snapshot?.artifacts?.find((a: Any) => a.id === pending[0]?.artifactId) ||
    snapshot?.artifacts?.at(-1);
  const approval = pending.find((a: Any) => a.artifactId === focus?.id);
  const build = snapshot?.builds?.at(-1);
  const canvasArtifacts = snapshot?.artifacts || [];
  const canvasHeight = Math.max(760, Math.ceil(canvasArtifacts.length / 4) * 180 + 40);
  const source = new URLSearchParams(location.search).get('source') === 'script' ? 'script' : 'human';
  const previewUrl = build ? build.preview + `?project=${projectId}&build=${build.id}&source=${source}` : '';
  useEffect(() => {
    const change = () => {
      setProjectId(location.hash.slice(1));
      setSnapshot(null);
      setInspectorExpanded(false);
      setSelected('');
      setReviewNote('');
      setSelection([]);
      setTab('classic');
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    let live = true;
    let taskKindInitialized = false;
    const refresh = async () => {
      try {
        const [p, s, detail] = await Promise.all([
          api('/projects'),
          api('/status'),
          projectId ? api('/projects/' + projectId) : Promise.resolve(null),
        ]);
        if (live) {
          setProjects(p);
          setStatus(s);
          setSnapshot(detail);
          if (detail && !taskKindInitialized) {
            setKind(detail.builds?.length ? 'iteration' : 'production');
            taskKindInitialized = true;
          }
        }
      } catch (e) {
        if (live) setError(String(e));
      }
    };
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId]);
  useEffect(() => {
    setSelection([]);
    setReviewNote('');
  }, [focus?.id]);
  useEffect(() => {
    if (pending[0]?.artifactId) setSelected(pending[0].artifactId);
  }, [pending[0]?.artifactId]);
  useEffect(() => {
    const receive = (e: MessageEvent) => {
      if (
        e.source !== iframeRef.current?.contentWindow ||
        e.origin !== snapshot?.previewOrigin ||
        e.data?.type !== 'game-agent:event'
      )
        return;
      const { buildId, sessionId, seed, difficulty, kind, data, at } = e.data;
      if (buildId !== build?.id) return;
      void api(`/projects/${projectId}/telemetry`, {
        buildId,
        sessionId,
        source,
        seed,
        difficulty,
        kind,
        data,
        at,
      }).catch((e) => setError('试玩记录保存失败：' + String(e)));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [projectId, build?.id, snapshot?.previewOrigin, source]);
  async function perform(fn: () => Promise<any>, message = '已保存') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      if (message) setNotice(message);
      if (projectId) setSnapshot(await api('/projects/' + projectId));
      setProjects(await api('/projects'));
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const p = await perform(() => api('/projects', { name, idea }), '项目已创建，请启动第一轮制作');
    if (p) {
      setCreateOpen(false);
      location.hash = p.id;
      setName('');
      setIdea('');
    }
  }
  function act(path: string, data: any, message?: string) {
    return perform(() => api(path, data), message);
  }
  async function upload(file: File) {
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    await act(
      `/projects/${projectId}/references`,
      { title: file.name, note: '用户补充的本地设计参考', data },
      '本地参考已保存',
    );
  }
  const assetUrl = (file: string) => `/api/projects/${projectId}/files/${file}`;
  const stats =
    snapshot?.events?.filter((e: Any) => e.kind === 'model-usage' || e.kind === 'coder-complete') || [];
  const tokenTotal = stats.reduce(
    (n: number, e: Any) =>
      n +
      (e.data.usage?.total_tokens || (e.data.usage?.input_tokens || 0) + (e.data.usage?.output_tokens || 0)),
    0,
  );
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳到主要内容
      </a>
      <aside className="sidebar">
        <a className="brand" href="#">
          <span className="brand-mark">✳</span>
          <div>
            游戏创作室<small>本地游戏 Agent 工作台</small>
          </div>
        </a>
        <button className={'nav-home ' + (!projectId ? 'chosen' : '')} onClick={() => (location.hash = '')}>
          <Icon>▦</Icon>工作空间
        </button>
        <div className="sidebar-label">
          我的项目{' '}
          <button aria-label="新建项目" onClick={() => setCreateOpen(true)}>
            ＋
          </button>
        </div>
        <div className="project-nav">
          {projects
            .filter((p) => showArchived || !p.archived)
            .map((p) => (
              <a
                href={'#' + p.id}
                key={p.id}
                className={p.id === projectId ? 'chosen' : ''}
                title={p.name}
                aria-current={p.id === projectId ? 'page' : undefined}
              >
                <span className="project-dot">◈</span>
                <span>
                  {p.name}
                  <small>{p.archived ? '已归档' : date(p.updatedAt)}</small>
                </span>
              </a>
            ))}
          {!projects.length && <p className="sidebar-empty">从一个小小的创意开始。</p>}
        </div>
        <label className="archived-toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          显示归档项目
        </label>
        <div className="sidebar-bottom">
          <span className={'connection-dot ' + (status.configured ? 'online' : '')} />
          {status.configured ? '方舟已配置' : '等待配置方舟密钥'}
          <small>个人工作空间 · 本地容器执行</small>
        </div>
      </aside>
      <main className="main-shell" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <div className="breadcrumb">
            <a href="#">工作空间</a>
            {snapshot && (
              <>
                <span>/</span>
                <strong>{snapshot.project.name}</strong>
              </>
            )}
          </div>
          <div className="topbar-right">
            <select
              className="mobile-project-select"
              aria-label="切换项目"
              value={projectId}
              onChange={(event) => {
                location.hash = event.target.value;
              }}
            >
              <option value="">工作空间</option>
              {projects
                .filter((p) => !p.archived || p.id === projectId || showArchived)
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                    {p.archived ? '（已归档）' : ''}
                  </option>
                ))}
            </select>
            <span className="local-chip">◎ 本地模式</span>
            <button
              className="text-button"
              onClick={() =>
                perform(async () => {
                  const e = await api('/environment');
                  setNotice(
                    `环境：密钥 ${e.credential ? '就绪' : '待配置'} · Docker ${e.docker ? '就绪' : '待启动'} · 编码镜像 ${e.coderImage ? '就绪' : '待构建'}`,
                  );
                }, '')
              }
            >
              检查环境
            </button>
          </div>
        </header>
        {error && (
          <div className="banner error" role="alert">
            <span>{error}</span>
            <button aria-label="关闭错误提示" onClick={() => setError('')}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="banner success" role="status">
            <span>{notice}</span>
            <button aria-label="关闭操作提示" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        {!projectId ? (
          <div className="workspace page">
            <div className="page-heading">
              <div>
                <h1>让创意，成为可以玩的游戏。</h1>
                <p>专业 Agent 协作制作，你来确认方向与关键方案。</p>
              </div>
              <button className="primary" onClick={() => setCreateOpen(true)}>
                ＋ 创建游戏项目
              </button>
            </div>
            <div className="overview-cards">
              <div>
                <span>项目</span>
                <strong>
                  {projects
                    .filter((p) => !p.archived)
                    .length.toString()
                    .padStart(2, '0')}
                </strong>
                <small>独立保存创意、版本和产物</small>
              </div>
              <div>
                <span>当前任务</span>
                <strong className="word-stat">{status.activeTask ? '执行中' : '待出发'}</strong>
                <small>同一时刻专注一个项目任务</small>
              </div>
              <div>
                <span>制作方式</span>
                <strong className="word-stat">人 × Agent</strong>
                <small>关键审核 · 真实编码 · 实测回收</small>
              </div>
            </div>
            <section className="journey">
              <div>
                <h2>一条有证据的创作路径</h2>
                <p>从调研到试玩，每个版本都有来处。</p>
              </div>
              <ol>
                <li>
                  <b>01</b>
                  <strong>确定方向</strong>
                  <span>参考选图 · 策划审核</span>
                </li>
                <li>
                  <b>02</b>
                  <strong>协作制作</strong>
                  <span>美术音频 · 游戏与关卡</span>
                </li>
                <li>
                  <b>03</b>
                  <strong>亲自体验</strong>
                  <span>本地试玩 · 脚本验证</span>
                </li>
                <li>
                  <b>04</b>
                  <strong>带证据迭代</strong>
                  <span>专家评审 · 实验结算</span>
                </li>
              </ol>
            </section>
            <div className="section-heading">
              <h2>最近项目</h2>
              <span>{projects.length} 个项目</span>
            </div>
            <div className="project-grid">
              {projects
                .filter((p) => showArchived || !p.archived)
                .map((p, i) => (
                  <a className="project-card" key={p.id} href={'#' + p.id}>
                    <div className={'project-cover cover-' + (i % 3)}>
                      <span>◈</span>
                      <small>{p.archived ? '已归档' : '本地单机游戏'}</small>
                    </div>
                    <div className="project-card-body">
                      <h3>{p.name}</h3>
                      <p>{p.idea}</p>
                      <footer>
                        <span>{date(p.updatedAt)}</span>
                        <span>打开项目 ↗</span>
                      </footer>
                    </div>
                  </a>
                ))}
              <button className="new-project-card" onClick={() => setCreateOpen(true)}>
                <span>＋</span>
                <strong>新的游戏，新的可能</strong>
                <small>输入创意，开始第一轮制作</small>
              </button>
            </div>
          </div>
        ) : !snapshot ? (
          <div className="empty">正在读取项目…</div>
        ) : (
          <div className="project-page page">
            <div className="page-heading">
              <div>
                <h1>{snapshot.project.name}</h1>
                <p>{snapshot.project.idea}</p>
              </div>
              <button
                className="text-button"
                onClick={() =>
                  act(
                    `/projects/${projectId}/archive`,
                    { archived: !snapshot.project.archived },
                    snapshot.project.archived ? '项目已恢复' : '项目已归档，产物保留',
                  )
                }
              >
                {snapshot.project.archived ? '恢复项目' : '归档项目'}
              </button>
            </div>
            <div
              className={'status-bar state-' + (latest?.status || 'ready')}
              role="status"
              aria-live="polite"
            >
              <div>
                <span className={'run-dot ' + latest?.status} />
                <div className="status-copy">
                  <strong>
                    {latest
                      ? `${taskNames[latest.kind] || '任务'} · ${statuses[latest.status] || latest.status}`
                      : '准备开始第一轮制作'}
                  </strong>
                  <span>
                    {latest ? stageLabel(latest.stage) : '在下方提交创意，制作团队将准备参考方向。'}
                  </span>
                </div>
              </div>
              {pending.length > 0 && (
                <button
                  className="primary"
                  onClick={() => {
                    setSelected(pending[0].artifactId);
                    setTab('classic');
                    setInspectorExpanded(true);
                  }}
                >
                  审核待确认方案（{pending.length}）
                </button>
              )}
              {active && (
                <div className="status-actions">
                  {['failed', 'interrupted', 'queued'].includes(active.status) && (
                    <button
                      onClick={() => act(`/tasks/${active.id}/continue`, {}, '任务已恢复')}
                      disabled={busy || !!status.activeTask}
                    >
                      继续任务
                    </button>
                  )}
                  <button
                    className="text-button"
                    onClick={() => act(`/tasks/${active.id}/cancel`, {}, '任务已取消，已有产物保留')}
                  >
                    取消任务
                  </button>
                </div>
              )}
            </div>
            {latest?.error && (
              <div className="task-error" role="alert">
                <p>当前步骤执行遇到问题，已有产物仍保留。查看错误详情后，可通过“继续任务”恢复执行。</p>
                <details>
                  <summary>查看错误详情</summary>
                  <pre>{latest.error}</pre>
                </details>
              </div>
            )}
            <nav className="view-tabs" aria-label="项目功能">
              {[
                ['classic', '◫', '经典视图'],
                ['canvas', '⌘', '画布视图'],
                ['play', '▷', '游戏试玩'],
                ['operations', '↗', '运营与实验'],
                ['memory', '▧', '记忆与知识'],
                ['report', '≋', '执行记录'],
              ].map(([key, icon, title]) => (
                <button
                  key={key}
                  aria-pressed={tab === key}
                  className={tab === key ? 'active' : ''}
                  onClick={() => setTab(key)}
                >
                  {icon} {title}
                  {key === 'classic' && pending.length > 0 && <b>{pending.length}</b>}
                </button>
              ))}
            </nav>
            {(tab === 'classic' || tab === 'canvas') && (
              <>
                <div className={'studio-layout ' + (inspectorExpanded ? 'expanded-review' : '')}>
                  <section className="work-column">
                    {tab === 'classic' ? (
                      <>
                        <div className="panel">
                          <div className="panel-heading">
                            <h2>制作路径</h2>
                            <span>产物按版本交接</span>
                          </div>
                          <div className="stage-grid">
                            {stages.map((r, i) => {
                              const item = snapshot.artifacts.findLast((a: Any) => a.role === r);
                              const reviewing = pending.some((a: Any) => a.artifactId === item?.id);
                              return (
                                <button
                                  key={r}
                                  disabled={!item}
                                  onClick={() => item && setSelected(item.id)}
                                  className={
                                    (focus?.role === r ? 'selected ' : '') + (item ? 'has-artifact' : '')
                                  }
                                >
                                  <small>{String(i + 1).padStart(2, '0')}</small>
                                  <span>{labels[r]}</span>
                                  <i>{reviewing ? '待审核' : item ? 'v' + item.version : '待制作'}</i>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div className="panel">
                          <div className="panel-heading">
                            <h2>执行动态</h2>
                            <span>{tokenTotal.toLocaleString()} tokens（最近事件记录）</span>
                          </div>
                          <div className="activity-list">
                            {snapshot.events
                              .filter(
                                (e: Any) => !['memory-read', 'model-start', 'model-usage'].includes(e.kind),
                              )
                              .filter(
                                (e: Any, i: number, all: Any[]) =>
                                  e.kind !== 'model-progress' ||
                                  !all
                                    .slice(i + 1)
                                    .some(
                                      (next: Any) =>
                                        next.kind === 'model-progress' &&
                                        next.taskId === e.taskId &&
                                        next.data.role === e.data.role,
                                    ),
                              )
                              .slice(-24)
                              .reverse()
                              .map((e: Any) => (
                                <div className="activity" key={e.seq}>
                                  <span className="activity-dot" />
                                  <div>
                                    <strong>{eventTitle(e)}</strong>
                                    <ActivityDetail event={e} />
                                  </div>
                                  <time>{date(e.at)}</time>
                                </div>
                              ))}
                            {!snapshot.events.length && (
                              <div className="empty compact">
                                <span>✦</span>
                                <p>你的创意准备好了，制作路径即将展开。</p>
                              </div>
                            )}
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="panel canvas-panel">
                        <div className="panel-heading">
                          <h2>产物画布</h2>
                          <div>
                            <span>全部 {canvasArtifacts.length} 个版本</span>
                            <button aria-label="缩小画布" onClick={() => setZoom(Math.max(0.5, zoom - 0.15))}>
                              −
                            </button>
                            <span>{Math.round(zoom * 100)}%</span>
                            <button aria-label="放大画布" onClick={() => setZoom(Math.min(1.8, zoom + 0.15))}>
                              ＋
                            </button>
                          </div>
                        </div>
                        <div className="canvas-scroll">
                          <div
                            className="artifact-canvas"
                            style={{ width: 1100 * zoom, height: canvasHeight * zoom }}
                          >
                            <div
                              style={{
                                transform: `scale(${zoom})`,
                                transformOrigin: 'top left',
                                position: 'relative',
                                width: 1100,
                                height: canvasHeight,
                              }}
                            >
                              <svg width="1100" height={canvasHeight} className="edges">
                                {canvasArtifacts.map((a: Any, i: number) =>
                                  a.inputVersions.map((id: string) => {
                                    const j = canvasArtifacts.findIndex((x: Any) => x.id === id);
                                    if (j < 0) return null;
                                    const x1 = (j % 4) * 260 + 240,
                                      y1 = Math.floor(j / 4) * 180 + 85,
                                      x2 = (i % 4) * 260 + 20,
                                      y2 = Math.floor(i / 4) * 180 + 85;
                                    return (
                                      <path
                                        key={id + a.id}
                                        d={`M${x1} ${y1} C${x1 + 50} ${y1},${x2 - 50} ${y2},${x2} ${y2}`}
                                      />
                                    );
                                  }),
                                )}
                              </svg>
                              {canvasArtifacts.map((a: Any, i: number) => (
                                <button
                                  key={a.id}
                                  style={{ left: (i % 4) * 260 + 20, top: Math.floor(i / 4) * 180 + 20 }}
                                  className={'canvas-node ' + (focus?.id === a.id ? 'selected' : '')}
                                  onClick={() => setSelected(a.id)}
                                >
                                  <small>
                                    {labels[a.role] || a.role} · v{a.version}
                                  </small>
                                  <strong>{a.title}</strong>
                                  <span>
                                    {a.data.summary || a.data.diagnosis || '点击查看产物与版本关联'}
                                  </span>
                                  <footer>
                                    {date(a.createdAt)} <b>↗</b>
                                  </footer>
                                </button>
                              ))}
                              {!snapshot.artifacts.length && (
                                <div className="empty">
                                  <p>制作开始后，产物将在这里连接成图。</p>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                    <form
                      className="composer panel"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void act(
                          `/projects/${projectId}/tasks`,
                          { kind, instruction: instruction || snapshot.project.idea },
                          '任务已启动',
                        ).then((r) => {
                          if (r) setInstruction('');
                        });
                      }}
                    >
                      <div className="panel-heading">
                        <h2>安排下一步</h2>
                        <select aria-label="任务类型" value={kind} onChange={(e) => setKind(e.target.value)}>
                          <option value="production">创意制作</option>
                          <option value="iteration">修改游戏</option>
                          <option value="analysis">试玩分析</option>
                          <option value="ideation">新游戏立项</option>
                        </select>
                      </div>
                      <p className="task-hint" id="task-hint">
                        {taskHints[kind]}
                      </p>
                      <textarea
                        id="task-instruction"
                        aria-label="任务要求"
                        aria-describedby="task-hint"
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder={
                          kind === 'ideation'
                            ? '例如：设计一款单局两分钟、操作更简单的躲避游戏…'
                            : kind === 'analysis'
                              ? '例如：重点分析新玩家的失败原因和操作体验…'
                              : kind === 'iteration'
                                ? '例如：将玩家飞船放大 50%，保持移动速度…'
                                : snapshot.project.idea
                        }
                        rows={3}
                      />
                      <div className="composer-footer">
                        <label className="upload">
                          ＋ 添加本地参考
                          <input
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            hidden
                            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
                          />
                        </label>
                        <button
                          className="primary"
                          disabled={busy || !!status.activeTask || snapshot.project.archived}
                        >
                          {busy ? '正在提交…' : '提交任务 ↗'}
                        </button>
                      </div>
                      {(status.activeTask || snapshot.project.archived) && (
                        <p className="action-hint">
                          {snapshot.project.archived
                            ? '恢复项目后可提交新任务。'
                            : '当前任务完成后可提交下一项操作；待审核方案可从上方进入。'}
                        </p>
                      )}
                      {snapshot.references.length > 0 && (
                        <small className="muted">
                          已有 {snapshot.references.length} 份本地参考，调研角色可读取。
                        </small>
                      )}
                    </form>
                  </section>
                  <aside className="inspector panel">
                    <div className="panel-heading">
                      <h2>{focus ? labels[focus.role] || '产物详情' : '产物详情'}</h2>
                      {focus && (
                        <div>
                          <span>v{focus.version}</span>
                          <button
                            className="text-button"
                            onClick={() => setInspectorExpanded(!inspectorExpanded)}
                          >
                            {inspectorExpanded ? '收起阅读' : '展开阅读'}
                          </button>
                        </div>
                      )}
                    </div>
                    {focus ? (
                      <>
                        <h3>{focus.title}</h3>
                        <p className="muted small">
                          {date(focus.createdAt)} · 输入 {focus.inputVersions.length} 个版本
                        </p>
                        {approval && (
                          <div className="review-box">
                            <h3>确认这一版，再继续。</h3>
                            <textarea
                              aria-label="审核意见"
                              placeholder="补充选择理由或修改意见"
                              value={reviewNote}
                              onChange={(e) => setReviewNote(e.target.value)}
                              rows={3}
                            />
                            <div>
                              <button
                                className="primary"
                                disabled={busy}
                                onClick={() =>
                                  act(
                                    `/approvals/${approval.id}`,
                                    {
                                      approved: true,
                                      feedback: reviewNote,
                                      selection: focus.role === 'research' ? selection : undefined,
                                    },
                                    '已批准此版本，流程继续',
                                  )
                                }
                              >
                                批准并继续
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  act(
                                    `/approvals/${approval.id}`,
                                    { approved: false, feedback: reviewNote },
                                    '修改意见已提交',
                                  )
                                }
                              >
                                修改这一版
                              </button>
                            </div>
                            {focus.role === 'delivery' && (
                              <button className="link-button" onClick={() => setTab('play')}>
                                先打开游戏试玩 →
                              </button>
                            )}
                          </div>
                        )}
                        <ArtifactView
                          artifact={focus}
                          assetUrl={assetUrl}
                          selection={selection}
                          onSelect={(id) =>
                            setSelection(
                              selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id],
                            )
                          }
                        />
                        <details>
                          <summary>完整结构与版本依据</summary>
                          <JsonView data={focus} />
                        </details>
                      </>
                    ) : (
                      <div className="empty compact">
                        <span>◈</span>
                        <p>选择一个产物，查看内容和审核状态。</p>
                      </div>
                    )}
                  </aside>
                </div>
              </>
            )}
            {tab === 'play' && (
              <div className="play-page">
                <div className="panel-heading">
                  <div>
                    <h2>游戏试玩</h2>
                    <p className="muted">点击画面后操作。试玩事件会保存到当前构建。</p>
                  </div>
                  {build && (
                    <div className="button-row">
                      <button
                        className="primary"
                        disabled={busy || !!status.activeTask}
                        onClick={() =>
                          act(
                            `/projects/${projectId}/tasks`,
                            {
                              kind: 'evaluation',
                              instruction: '运行真实浏览器行为回归与离线检查，记录脚本来源的试玩和测评。',
                            },
                            '浏览器回归已启动',
                          )
                        }
                      >
                        运行脚本测评
                      </button>
                      <a className="button" href={`/api/projects/${projectId}/downloads/${build.id}/source`}>
                        下载源码
                      </a>
                      <a className="button" href={`/api/projects/${projectId}/downloads/${build.id}/web`}>
                        下载游戏包
                      </a>
                    </div>
                  )}
                </div>
                {build ? (
                  <>
                    <iframe
                      ref={iframeRef}
                      title="游戏试玩"
                      src={previewUrl}
                      className="game-frame"
                      sandbox="allow-scripts allow-same-origin"
                    />
                    <div className="panel play-feedback">
                      <div>
                        <h3>记录本次体验</h3>
                        <p>
                          当前构建：{build.id.slice(0, 8)} · 人工完整局数{' '}
                          {snapshot.playMetrics?.human.completedSessions || 0}
                        </p>
                        <select
                          aria-label="体验评分"
                          value={rating}
                          onChange={(e) => setRating(+e.target.value)}
                        >
                          {[5, 4, 3, 2, 1].map((x) => (
                            <option key={x} value={x}>
                              {x} / 5
                            </option>
                          ))}
                        </select>
                      </div>
                      <textarea
                        aria-label="试玩体验反馈"
                        placeholder="操作是否符合预期？哪里值得改进？"
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                      />
                      <button
                        className="primary"
                        disabled={busy || !feedback.trim()}
                        onClick={() =>
                          act(
                            `/projects/${projectId}/feedback`,
                            { buildId: build.id, rating, note: feedback },
                            '试玩反馈已保存',
                          ).then((r) => r && setFeedback(''))
                        }
                      >
                        保存反馈
                      </button>
                    </div>
                    {snapshot.evaluations
                      .filter((r: Any) => r.buildId === build.id)
                      .map((r: Any) => (
                        <div className="panel" key={r.id}>
                          <div className="panel-heading">
                            <h3>
                              脚本测评 · {r.passed}/{r.total} 通过
                            </h3>
                            <span>{date(r.at)}</span>
                          </div>
                          {r.checks.map((c: Any) => (
                            <div className="evaluation-line" key={c.id}>
                              <Pill value={c.passed ? 'completed' : 'failed'} />
                              <strong>{c.title}</strong>
                              {c.error && <p className="task-error">{c.error}</p>}
                              <details>
                                <summary>观测证据</summary>
                                <JsonView data={c.evidence || c.error} />
                              </details>
                            </div>
                          ))}
                        </div>
                      ))}
                  </>
                ) : (
                  <div className="empty large">
                    <span>▷</span>
                    <h2>完成制作后，即可试玩</h2>
                    <p>完成制作与构建后，这里将提供真实游戏预览。</p>
                    <button onClick={() => setTab('classic')}>前往制作视图</button>
                  </div>
                )}
              </div>
            )}
            {tab === 'operations' && (
              <OperationsPanel
                key={projectId}
                snapshot={snapshot}
                busy={busy}
                blockedReason={
                  snapshot.project.archived
                    ? '恢复项目后可启动任务。'
                    : status.activeTask
                      ? '当前任务完成后可启动下一项操作。'
                      : ''
                }
                onReview={(id) => {
                  setSelected(id);
                  setTab('classic');
                  setInspectorExpanded(true);
                }}
                onPrepare={(nextKind) => {
                  setKind(nextKind);
                  setTab('classic');
                  setInspectorExpanded(false);
                  requestAnimationFrame(() => document.getElementById('task-instruction')?.focus());
                }}
                onAnalyze={() =>
                  void act(
                    `/projects/${projectId}/tasks`,
                    {
                      kind: 'analysis',
                      instruction:
                        '分析当前游戏的实际试玩与回归数据，优先核对需求完成和稳定交付，提出一项有证据的具体改进。',
                    },
                    '专家分析已启动',
                  )
                }
                onInspect={() =>
                  void perform(async () => {
                    const r = await api(`/projects/${projectId}/inspect`, {});
                    setNotice(
                      `巡检完成：${r.dueExperiments.length} 项到期实验、${r.pendingApprovals.length} 项审核、${r.interruptedTasks.length} 项待恢复任务。`,
                    );
                  }, '')
                }
                onExecute={(a) => {
                  if (a.role === 'proposal')
                    void act(
                      `/projects/${projectId}/execute-proposal`,
                      { proposalId: a.id },
                      '已预登记实验并启动修改',
                    );
                  else
                    void act(
                      `/projects/${projectId}/execute-ideation`,
                      { artifactId: a.id },
                      '已创建并启动立项项目',
                    ).then((r) => {
                      if (r) location.hash = r.newProjectId;
                    });
                }}
                onSettle={(id, passed, evidence) =>
                  perform(async () => {
                    const r = await api(`/experiments/${id}/settle`, { guardrailsPassed: passed, evidence });
                    setNotice(r.pendingReason || '结算已保存，知识候选进入审核');
                  }, '')
                }
              />
            )}
            {tab === 'report' && <ExecutionReport projectId={projectId} />}
            {tab === 'memory' && (
              <>
                <KnowledgeEditor
                  key={projectId}
                  knowledge={snapshot.knowledge}
                  onSave={(input) => act(`/projects/${projectId}/knowledge`, input, '知识变更已进入待审核区')}
                />
                <div className="memory-layers">
                  <div>
                    <b>01</b>
                    <h3>核心规则</h3>
                    <p>任务目标、证据纪律与人工审核边界，每次执行注入。</p>
                  </div>
                  <div>
                    <b>02</b>
                    <h3>知识</h3>
                    <p>任务相关经验，保留范围、证据、版本与反证。</p>
                  </div>
                  <div>
                    <b>03</b>
                    <h3>历史</h3>
                    <p>产物、分析、变更、实验与原始事件可追溯。</p>
                  </div>
                  <div>
                    <b>04</b>
                    <h3>会话</h3>
                    <p>角色消息与编码会话，支持中断后的继续执行。</p>
                  </div>
                </div>
                <div className="section-heading">
                  <h2>知识审核与版本</h2>
                  <span>{snapshot.knowledge.length} 条记录</span>
                </div>
                <div className="knowledge-grid">
                  {snapshot.knowledge.map((k: Any) => (
                    <div className="panel" key={k.id}>
                      <div className="panel-heading">
                        <Pill value={k.status} />
                        <span>
                          v{k.version} · {k.scope}
                        </span>
                      </div>
                      <h3>{k.title}</h3>
                      <p className="preserve-lines">{k.content}</p>
                      <p className="muted">适用限制：{k.limitations}</p>
                      <small>证据：{k.evidence.join('、')}</small>
                      {k.counterEvidence.length > 0 && <p>反证：{k.counterEvidence.join('、')}</p>}
                      {k.status === 'pending' && (
                        <div className="button-row">
                          <button
                            className="primary"
                            onClick={() =>
                              act(
                                `/knowledge/${k.id}/review`,
                                { approved: true, note: '用户审核通过' },
                                '知识版本已生效',
                              )
                            }
                          >
                            批准知识
                          </button>
                          <button
                            onClick={() =>
                              act(
                                `/knowledge/${k.id}/review`,
                                { approved: false, note: reviewNote || '需要更多证据' },
                                '知识提案已驳回',
                              )
                            }
                          >
                            驳回
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {!snapshot.knowledge.length && (
                  <div className="panel empty">
                    <span>▧</span>
                    <p>实验结算将产生有来源的知识候选，经你审核后生效。</p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
      {createOpen && (
        <CreateDialog onClose={() => setCreateOpen(false)}>
          <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={create}>
            <div className="panel-heading">
              <h2 id="create-title">从一个想法开始</h2>
              <button
                type="button"
                aria-label="关闭新建项目"
                className="text-button"
                onClick={() => setCreateOpen(false)}
              >
                ×
              </button>
            </div>
            <p className="muted">说清玩法与目标，制作团队会先准备方向供你确认。</p>
            <label>
              项目名称
              <input
                name="project-name"
                autoComplete="off"
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：星际航线"
              />
            </label>
            <label>
              游戏创意
              <textarea
                name="game-idea"
                required
                minLength={5}
                rows={5}
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                placeholder="太空陨石躲避：WASD/方向键移动、三种难度、暂停、重开，使用固定 Seed 关卡。"
              />
            </label>
            <div className="modal-footer">
              <span>本地单机 · 躲避类游戏</span>
              <button className="primary" disabled={busy}>
                创建项目 →
              </button>
            </div>
          </form>
        </CreateDialog>
      )}
    </div>
  );
}

function ExecutionReport({ projectId }: { projectId: string }) {
  const [report, setReport] = useState<Any | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const refresh = () =>
      api(`/projects/${projectId}/report`)
        .then((r) => {
          if (live) setReport(r);
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [projectId]);
  const duration = (ms: number) => `${Math.round((ms || 0) / 1000)} 秒`;
  return (
    <section>
      <div className="panel-heading">
        <div>
          <h2>任务执行与用量</h2>
          <p className="muted">全量事件计算耗时；服务端用量保留原始单位，账单由服务方核对。</p>
        </div>
        <a href={`/api/projects/${projectId}/report`} target="_blank" rel="noreferrer">
          查看完整 JSON ↗
        </a>
      </div>
      {error && <p role="alert">{error}</p>}
      {report?.tasks.map((task: Any) => (
        <div className="panel report-card" key={task.taskId}>
          <div className="panel-heading">
            <h3>
              {task.taskId.slice(0, 8)} · {task.kind}
            </h3>
            <Pill value={task.status} />
          </div>
          <div className="metric-row">
            <div>
              <strong>{duration(task.wallMs)}</strong>
              <span>总经过时间</span>
            </div>
            <div>
              <strong>{duration(task.stateDurationsMs.running)}</strong>
              <span>执行中（含服务等待）</span>
            </div>
            <div>
              <strong>{duration(task.stateDurationsMs.review)}</strong>
              <span>审核等待（含委托审核）</span>
            </div>
          </div>
          <p>
            文本请求 {task.modelAttempts ?? task.modelRequests} 次 / 已返回 {task.modelRequests} 次 · 工具调用{' '}
            {task.toolCalls} 次 · 审核决定 {task.reviewDecisions.length} 次 · 异常记录 {task.failures.length}{' '}
            条
          </p>
          <details>
            <summary>模型、媒体及编码用量</summary>
            <JsonView data={{ model: task.modelUsage, media: task.mediaUsage, coding: task.codingJobs }} />
          </details>
          <details>
            <summary>审核与异常轨迹</summary>
            <JsonView data={{ approvals: task.reviewDecisions, failures: task.failures }} />
          </details>
        </div>
      ))}
    </section>
  );
}

function KnowledgeEditor({ knowledge, onSave }: { knowledge: Any[]; onSave: (input: Any) => Promise<any> }) {
  const [action, setAction] = useState('add'),
    [previousId, setPrevious] = useState('');
  const [title, setTitle] = useState(''),
    [content, setContent] = useState(''),
    [evidence, setEvidence] = useState('');
  const [limitations, setLimitations] = useState('当前项目与已记录证据范围'),
    [scope, setScope] = useState('operations');
  const [saving, setSaving] = useState(false);
  const choose = (id: string) => {
    setPrevious(id);
    const item = knowledge.find((k) => k.id === id);
    if (item) {
      setTitle(item.title);
      setContent(item.content);
      setScope(item.scope);
      setLimitations(item.limitations);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const previous = knowledge.find((k) => k.id === previousId);
    try {
      const result = await onSave({
        action,
        previousId: action === 'add' ? undefined : previousId,
        title,
        content,
        scope,
        limitations,
        tags: previous?.tags || ['dodge'],
        evidence: [
          ...(action === 'add' ? [] : previous?.evidence || []),
          ...evidence
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        ],
        counterEvidence: previous?.counterEvidence || [],
      });
      if (result) setEvidence('');
    } finally {
      setSaving(false);
    }
  };
  return (
    <details className="panel knowledge-editor">
      <summary>提出知识新增、修订或退役</summary>
      <form onSubmit={submit}>
        <div className="button-row">
          <label>
            变更类型
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="add">新增经验</option>
              <option value="revise">修订已有版本</option>
              <option value="retire">退役已有版本</option>
            </select>
          </label>
          <label>
            任务范围
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="production">生产</option>
              <option value="operations">运营</option>
            </select>
          </label>
        </div>
        {action !== 'add' && (
          <label>
            已有批准版本
            <select required value={previousId} onChange={(e) => choose(e.target.value)}>
              <option value="">选择知识</option>
              {knowledge
                .filter((k) => k.status === 'approved')
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.title} · v{k.version}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          标题
          <input required value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          结论或退役理由
          <textarea required rows={3} value={content} onChange={(e) => setContent(e.target.value)} />
        </label>
        <label>
          新增证据（每行一个事件、实验或文件引用）
          <textarea required rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </label>
        <label>
          适用限制
          <input required value={limitations} onChange={(e) => setLimitations(e.target.value)} />
        </label>
        <button className="primary" disabled={saving}>
          提交到待审核区
        </button>
      </form>
    </details>
  );
}

function ArtifactView({
  artifact: a,
  assetUrl,
  selection,
  onSelect,
}: {
  artifact: Any;
  assetUrl: (f: string) => string;
  selection: string[];
  onSelect: (id: string) => void;
}) {
  const d = a.data;
  if (a.role === 'research')
    return (
      <div>
        <p>{d.summary}</p>
        <div className="reference-list">
          {d.candidates.map((c: Any) => (
            <button
              key={c.id}
              className={'reference-card ' + (selection.includes(c.id) ? 'selected' : '')}
              onClick={() => onSelect(c.id)}
            >
              {c.imageUrl ? (
                <img
                  src={c.imageUrl}
                  alt={c.title}
                  width={480}
                  height={270}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="reference-placeholder">◈</div>
              )}
              <div>
                <strong>
                  {selection.includes(c.id) ? '✓ ' : ''}
                  {c.title}
                </strong>
                <p>{c.mechanics}</p>
                <small>{c.artDirection}</small>
              </div>
            </button>
          ))}
        </div>
        <p>{d.recommendation}</p>
        <div className="source-links">
          {d.candidates.map((c: Any) => (
            <a key={c.id} href={c.url} target="_blank" rel="noreferrer">
              {c.title} 来源 ↗
            </a>
          ))}
        </div>
      </div>
    );
  if (a.role === 'planner')
    return (
      <div>
        <p>{d.summary}</p>
        <h4>验收需求</h4>
        {d.requirements.map((r: Any) => (
          <div className="requirement" key={r.id}>
            <strong>{r.description}</strong>
            <p>{r.acceptance}</p>
          </div>
        ))}
        <h4>规则</h4>
        <ul>
          {d.rules.map((r: string) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <p className="muted">美术风格：{d.artStyle}</p>
      </div>
    );
  if (a.role === 'art')
    return (
      <div>
        <p>{d.summary}</p>
        {d.frameFile && (
          <img
            className="layout-preview"
            src={assetUrl(d.frameFile)}
            alt="游戏页面框架"
            width={960}
            height={640}
            loading="lazy"
          />
        )}
        <div className="asset-grid">
          {d.assets.map((x: Any) => (
            <figure key={x.id}>
              <img src={assetUrl(x.file)} alt={x.id} width={512} height={512} loading="lazy" />
              <figcaption>{x.id}</figcaption>
            </figure>
          ))}
        </div>
        <p>{d.visualAnalysis}</p>
      </div>
    );
  if (a.role === 'audio')
    return (
      <div>
        <p>{d.summary}</p>
        {d.assets.map((x: Any) => (
          <div className="audio-item" key={x.id}>
            <strong>
              {x.id} · {x.category}
            </strong>
            <p>{x.trigger}</p>
            <audio src={assetUrl(x.file)} controls />
            <small>{x.source}</small>
          </div>
        ))}
      </div>
    );
  if (a.role === 'producer')
    return (
      <div>
        <p>{d.summary}</p>
        <ol>
          {d.roles.map((r: string) => (
            <li key={r}>{labels[r]}</li>
          ))}
        </ol>
        <p>{d.reason}</p>
        <ul>
          {d.assumptions.map((x: string) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    );
  if (a.role === 'proposal')
    return (
      <div>
        <p>{d.diagnosis}</p>
        <h4>具体修改</h4>
        <p className="preserve-lines">{d.instruction}</p>
        <h4>预登记</h4>
        <p>
          {d.metric === 'survivalSeconds' ? '生存时长（秒）' : '需求通过率'}：{d.baseline} → {d.targetMin}–
          {d.targetMax}
        </p>
        <p>
          {d.source === 'human' ? '人工试玩' : '脚本测评'} / Seed {d.seed} / {d.difficulty || 'normal'} /{' '}
          {d.minSamples} 个样本
        </p>
        <p>失败判据：{d.falsification}</p>
        <ul>
          {d.unresolved.map((x: string) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </div>
    );
  if (a.role === 'ideation')
    return (
      <div className="ideation-detail">
        <p>{d.rationale}</p>
        <h4>制作约束</h4>
        <ul>
          {d.constraints.map((x: string) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <h4>候选游戏</h4>
        {d.candidates.map((candidate: Any, i: number) => (
          <section className={'candidate-summary ' + (i === d.selected ? 'chosen-candidate' : '')} key={i}>
            <span>{i === d.selected ? '选定候选' : '备选方向'}</span>
            <h3>{candidate.title}</h3>
            <p>{candidate.idea}</p>
            <details>
              <summary>候选依据</summary>
              <ul>
                {candidate.evidence.map((x: string) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </details>
          </section>
        ))}
        {d.challenges.length > 0 && (
          <details>
            <summary>待验证问题（{d.challenges.length}）</summary>
            <ul>
              {d.challenges.map((x: string) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    );
  if (['pd', 'dev', 'reviewer', 'analyst', 'gd'].includes(a.role)) return <ExpertView data={d} />;
  if (a.role === 'discussion')
    return (
      <div className="discussion-detail">
        <p>专家完成 {d.rounds?.length || 0} 轮讨论。以下为各角色的最终判断，完整讨论保存在版本依据中。</p>
        {Object.entries(d.final || {}).map(([role, data]) => (
          <details key={role}>
            <summary>{labels[role] || role} · 最终意见</summary>
            <ExpertView data={data as Any} />
          </details>
        ))}
      </div>
    );
  if (a.role === 'delivery')
    return (
      <div>
        <p>源码、浏览器包和测试记录已生成。请在“游戏试玩”核对实际操作后批准交付。</p>
        <Pill value={d.status} />
        <details>
          <summary>自动测试记录</summary>
          <pre>{d.tests}</pre>
        </details>
      </div>
    );
  if (a.role === 'game' || a.role === 'level-code')
    return (
      <div>
        <p>{d.result?.summary}</p>
        <p className="preserve-lines">{d.result?.interface}</p>
        <Pill value={d.status} />
        <details>
          <summary>真实测试结果</summary>
          <pre>{d.testOutput}</pre>
        </details>
      </div>
    );
  return <JsonView data={d} />;
}
function ExpertView({ data: d }: { data: Any }) {
  return (
    <div className="expert-detail">
      <p className="expert-summary">{d.summary}</p>
      {d.observations?.length > 0 && (
        <>
          <h4>关键发现</h4>
          <ul>
            {d.observations.map((x: string) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </>
      )}
      {d.hypothesis && (
        <>
          <h4>待验证判断</h4>
          <p>{d.hypothesis}</p>
        </>
      )}
      {d.changes?.length > 0 && (
        <>
          <h4>建议修改</h4>
          {d.changes.map((x: Any, i: number) => (
            <div className="requirement" key={i}>
              <code>{x.file}</code>
              <p>{x.change}</p>
            </div>
          ))}
        </>
      )}
      {(
        [
          ['evidence', '证据依据'],
          ['risks', '风险与影响'],
          ['questions', '待确认问题'],
        ] as const
      ).map(
        ([key, title]) =>
          d[key]?.length > 0 && (
            <details key={key}>
              <summary>
                {title}（{d[key].length}）
              </summary>
              <ul>
                {d[key].map((x: string) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </details>
          ),
      )}
    </div>
  );
}
function ActivityDetail({ event }: { event: Any }) {
  const value = eventDetail(event);
  const detail = typeof value === 'string' ? value : pretty(value);
  if (!detail) return null;
  const structured = /^\s*[[{]/.test(detail);
  if (detail.length <= 160 && !structured) return <p>{detail}</p>;
  const error = event.data.error || /error|invalid|failed/.test(event.kind);
  return (
    <div className="activity-detail">
      <p>
        {error
          ? '此步骤记录了异常，展开查看详细原因。'
          : structured
            ? '已保存详细执行信息。'
            : detail.replace(/\s+/g, ' ').slice(0, 100) + '…'}
      </p>
      <details>
        <summary>查看动态详情</summary>
        <pre>{detail}</pre>
      </details>
    </div>
  );
}
function eventTitle(e: Any) {
  return (
    (
      {
        'task-created': '任务已创建',
        artifact: `${labels[e.data.role] || e.data.role}产物已保存`,
        approval: e.data.approved ? '版本已批准' : '已提交修改意见',
        'tool-start': `调用工具 · ${e.data.tool}`,
        'tool-result': `工具完成 · ${e.data.tool}`,
        'tool-error': `工具遇到问题 · ${e.data.tool}`,
        'model-retry': `${labels[e.data.role] || e.data.role} · 超时后自动重试`,
        'model-output-invalid': `${labels[e.data.role] || e.data.role} · 输出校验需修正`,
        'model-progress': `${labels[e.data.role] || e.data.role} · 生成进度（${e.data.outputChars || 0} 字符，${e.data.chunks || 0} 个流片段）`,
        'coder-start': `${labels[e.data.role]}开始执行`,
        'coder-complete': `${labels[e.data.role]}完成`,
        'coder-event': `${labels[e.data.role]} · ${e.data.name || e.data.type}`,
        task: statuses[e.data.status] || '任务状态更新',
        build: '构建包已生成',
        settlement: '实验已结算',
      } as Any
    )[e.kind] || e.kind
  );
}
function eventDetail(e: Any) {
  if (e.kind === 'coder-event' && e.data.type === 'progress')
    return `${e.data.phase === 'generated' ? '本段生成完成' : '正在生成'} · ${Number(e.data.characters).toLocaleString()} 字符 · 文件写入以工具完成记录为准`;
  if (e.kind === 'coder-event')
    return (
      e.data.text?.slice(0, 300) || e.data.input?.file_path || e.data.input?.command || e.data.error || ''
    );
  return (
    e.data.instruction ||
    e.data.feedback ||
    e.data.error ||
    e.data.reason ||
    e.data.title ||
    (e.data.stage ? stageLabel(e.data.stage) : '')
  );
}
createRoot(document.getElementById('root')!).render(<App />);
