import React, { useState } from 'react';

type Any = Record<string, any>;
type Props = {
  snapshot: Any;
  busy: boolean;
  blockedReason: string;
  onReview: (id: string) => void;
  onPrepare: (kind: string) => void;
  onAnalyze: () => void;
  onInspect: () => void;
  onExecute: (artifact: Any) => void;
  onSettle: (id: string, passed: boolean, evidence: string) => Promise<any>;
};
const statusLabels: Record<string, string> = {
  approved: '已批准',
  pending: '待审核',
  rejected: '需修改',
  registered: '已预登记',
  observing: '观察中',
  settled: '已结算',
  positive: '预测命中',
  negative: '预测未命中',
  mixed: '命中但护栏未通过',
  insufficient: '证据不足',
};
const formatDate = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
function Status({ value }: { value: string }) {
  return <span className={'pill ' + value}>{statusLabels[value] || value}</span>;
}

export default function OperationsPanel(props: Props) {
  const { snapshot, busy, blockedReason, onReview, onPrepare, onAnalyze, onInspect, onExecute, onSettle } =
    props;
  const [section, setSection] = useState('proposal');
  const [history, setHistory] = useState(false);
  const artifacts = snapshot.artifacts
    .filter((a: Any) => a.role === section)
    .slice()
    .reverse();
  const visible = history ? artifacts : artifacts.slice(0, 1);
  const count = (role: string) => snapshot.artifacts.filter((a: Any) => a.role === role).length;
  const isNewGame = section === 'ideation';
  return (
    <section className="operations-page" aria-label="运营与实验">
      <div className="section-intro">
        <div>
          <h2>把试玩发现，变成下一步行动</h2>
          <p>改进当前游戏、探索新游戏，分别保留方案与审核记录。</p>
        </div>
        <button disabled={busy} onClick={onInspect}>
          执行巡检
        </button>
      </div>
      <div className="operations-nav" role="group" aria-label="运营工作区">
        {[
          ['proposal', '改进当前游戏', count('proposal')],
          ['ideation', '制作新游戏', count('ideation')],
          ['experiments', '实验与结算', snapshot.experiments.length],
        ].map(([key, title, total]) => (
          <button
            key={key}
            aria-pressed={section === key}
            className={section === key ? 'selected' : ''}
            onClick={() => {
              setSection(String(key));
              setHistory(false);
            }}
          >
            {title}
            <span className="count">{total}</span>
          </button>
        ))}
      </div>
      {section === 'experiments' ? (
        <>
          <div className="section-intro">
            <div>
              <h2>实验与结算</h2>
              <p>修改前保存基线与预测；修改后收集同条件样本，核对改进效果。</p>
            </div>
          </div>
          {snapshot.experiments.length ? (
            snapshot.experiments
              .slice()
              .reverse()
              .map((experiment: Any) => (
                <ExperimentCard key={experiment.id} experiment={experiment} busy={busy} onSettle={onSettle} />
              ))
          ) : (
            <div className="panel empty compact">
              <h3>等待第一项实验</h3>
              <p>批准当前游戏的迭代提案，再执行修改，即可开始观察。</p>
              <button onClick={() => setSection('proposal')}>查看当前游戏提案</button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="operation-brief">
            <div>
              <h2>{isNewGame ? '用已有经验，规划另一款游戏' : '从当前游戏的真实反馈中找改进'}</h2>
              <p>
                {isNewGame
                  ? '专家结合你的目标、历史实验和已审核知识提出候选。批准立项后，会创建独立项目并开始制作。'
                  : '专家分析试玩与测评，提交具体修改和效果预测。批准后，先预登记实验，再修改当前项目。'}
              </p>
              <ol className="operation-steps">
                {(isNewGame
                  ? ['描述目标', '审核立项方案', '创建并制作']
                  : ['收集试玩', '分析与审核', '修改并测评', '结算效果']
                ).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
            <div className="operation-launch">
              <button
                className="primary"
                disabled={busy || !!blockedReason}
                onClick={isNewGame ? () => onPrepare('ideation') : onAnalyze}
              >
                {isNewGame ? '准备新游戏立项' : '启动试玩分析'}
              </button>
              <small>
                {blockedReason || (isNewGame ? '填写立项要求后提交' : '将调用 AI 专家分析当前项目')}
              </small>
            </div>
          </div>
          {!isNewGame && (
            <div className="evidence-strip" aria-label="当前项目证据">
              <span>
                <b>{snapshot.metrics?.human.completedSessions || 0}</b> 人工完整局
              </span>
              <span>
                <b>{snapshot.metrics?.script.completedSessions || 0}</b> 脚本完整局
              </span>
              <span>
                <b>{snapshot.evaluations.length}</b> 测评报告
              </span>
              <small>人工体验与脚本记录分别统计</small>
            </div>
          )}
          <div className="section-heading proposal-heading">
            <h2>{isNewGame ? '新游戏立项方案' : '当前游戏迭代提案'}</h2>
            {artifacts.length > 1 && (
              <button className="text-button" aria-expanded={history} onClick={() => setHistory(!history)}>
                {history ? '收起历史方案' : `查看历史方案（${artifacts.length - 1}）`}
              </button>
            )}
          </div>
          {visible.map((a: Any) => {
            const approval = snapshot.approvals.findLast((x: Any) => x.artifactId === a.id);
            const registered = snapshot.experiments.find((x: Any) => x.proposalId === a.id);
            const reason = blockedReason || (approval?.status !== 'approved' ? '审核通过后即可执行。' : '');
            const candidate = isNewGame && a.data.candidates?.[a.data.selected];
            return (
              <article className="panel proposal-card" key={a.id}>
                <div className="panel-heading">
                  <span>
                    v{a.version} · {formatDate(a.createdAt)}
                  </span>
                  <Status value={approval?.status || 'pending'} />
                </div>
                <h3>{a.title}</h3>
                <ExpandableText text={a.data.diagnosis || a.data.rationale || ''} limit={200} label="摘要" />
                {candidate && (
                  <div className="candidate-summary">
                    <span>选定候选</span>
                    <strong>{candidate.title}</strong>
                    <ExpandableText text={candidate.idea} limit={140} label="候选介绍" />
                  </div>
                )}
                <div className="proposal-action">
                  <p>
                    {registered
                      ? '此提案已预登记实验，可前往实验与结算查看进展。'
                      : isNewGame
                        ? '执行后：创建独立项目，并进入调研、策划与制作流程。'
                        : '执行后：保存实验基线与预测，并在当前项目启动修改。'}
                  </p>
                  <div className="button-row">
                    <button onClick={() => onReview(a.id)}>
                      {approval?.status === 'pending' ? '查看与审核' : '查看完整方案'}
                    </button>
                    {registered ? (
                      <button onClick={() => setSection('experiments')}>查看对应实验</button>
                    ) : (
                      <button
                        className={approval?.status === 'approved' ? 'primary' : ''}
                        disabled={busy || !!reason}
                        onClick={() => onExecute(a)}
                      >
                        {isNewGame ? '创建并制作新游戏' : '预登记并执行修改'}
                      </button>
                    )}
                  </div>
                  {reason && !registered && <small className="action-hint">{reason}</small>}
                </div>
              </article>
            );
          })}
          {!artifacts.length && (
            <div className="panel empty compact">
              <h3>{isNewGame ? '准备下一款游戏的方向' : '等待第一份改进提案'}</h3>
              <p>
                {isNewGame
                  ? '填写玩法目标、单局时长和制作约束，专家会提交候选方案供你审核。'
                  : '先完成试玩并保存反馈，再启动试玩分析。提案会出现在这里。'}
              </p>
              <button onClick={() => onPrepare(isNewGame ? 'ideation' : 'analysis')}>
                填写{isNewGame ? '立项要求' : '分析重点'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ExpandableText({ text, limit, label }: { text: string; limit: number; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const characters = Array.from(text);
  const long = characters.length > limit;
  return (
    <div className="expandable-text">
      <p className="proposal-summary">
        {long && !expanded ? characters.slice(0, limit).join('') + '…' : text}
      </p>
      {long && (
        <button
          type="button"
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起' : '展开完整'}
          {label}
        </button>
      )}
    </div>
  );
}

function ExperimentCard({
  experiment: e,
  busy,
  onSettle,
}: {
  experiment: Any;
  busy: boolean;
  onSettle: Props['onSettle'];
}) {
  const [passed, setPassed] = useState(true);
  const [evidence, setEvidence] = useState('');
  return (
    <article className="panel experiment-card">
      <div className="panel-heading">
        <h3>
          {e.metric === 'survivalSeconds' ? '生存时长' : '需求通过率'} ·{' '}
          {e.source === 'human' ? '人工试玩' : '脚本测评'}
        </h3>
        <Status value={e.status} />
      </div>
      <div className="experiment-metrics">
        <div>
          <span>修改前基线</span>
          <strong>{e.baseline.toFixed(2)}</strong>
        </div>
        <div>
          <span>预期范围</span>
          <strong>
            {e.targetMin}–{e.targetMax}
          </strong>
        </div>
      </div>
      <p className="muted">
        Seed {e.seed} · 最少 {e.minSamples} 个样本 · 观察 {e.windowMinutes} 分钟
      </p>
      <details className="experiment-criteria">
        <summary>查看护栏与失败判据</summary>
        <ul>
          {e.guardrails.map((g: string, i: number) => (
            <li key={i}>{g}</li>
          ))}
        </ul>
        <p>{e.falsification}</p>
      </details>
      {e.settlement ? (
        <div className="settlement-result">
          <Status value={e.settlement.classification} />
          <details>
            <summary>查看结算证据</summary>
            <pre className="json-view">{JSON.stringify(e.settlement, null, 2)}</pre>
          </details>
        </div>
      ) : (
        <div className="settlement-form">
          <label className="checkbox-label">
            <input type="checkbox" checked={passed} onChange={(event) => setPassed(event.target.checked)} />
            护栏检查通过
          </label>
          <label>
            结算依据
            <textarea
              rows={3}
              placeholder="填写护栏检查证据、试玩条件与样本限制…"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </label>
          <button disabled={busy} onClick={() => onSettle(e.id, passed, evidence)}>
            执行到期结算
          </button>
          <small className="action-hint">到期且样本充足后保存结算；结论将形成待审核的知识候选。</small>
        </div>
      )}
    </article>
  );
}
