import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';

mkdirSync('.local/tests', { recursive: true });
process.env.AGENT_DATA_DIR = mkdtempSync(resolve('.local/tests/game-evaluation-'));
process.env.ARK_AGENT_PLAN_API_KEY = '';
const root = join(process.env.AGENT_DATA_DIR, 'synthetic-game');
mkdirSync(root);
const server = createServer((req, res) => {
  const file = resolve(root, '.' + new URL(req.url!, 'http://localhost').pathname);
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.wav': 'audio/wav',
    };
    res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
process.env.PREVIEW_PORT = String((server.address() as any).port);
const { createProject, put, list, uid } = await import('../src/store.js');
const { runBrowserEvaluation } = await import('../src/browser-evaluation.js');
const { wav } = await import('../src/tools.js');
const { now } = await import('../src/config.js');

test(
  'real browser evaluator exercises shell and isolates baseline telemetry from regression sessions',
  { timeout: 90000 },
  async () => {
    try {
      // Controlled synthetic module tests the evaluator; it is never a production game or model output.
      for (const file of ['shell.mjs', 'shell.css', 'index.html', 'blueprint.html'])
        cpSync(join('templates/game', file), join(root, file));
      mkdirSync(join(root, 'assets'));
      await sharp({ create: { width: 16, height: 16, channels: 4, background: '#00ffff' } })
        .png()
        .toFile(join(root, 'assets/player.png'));
      writeFileSync(
        join(root, 'assets/beep.wav'),
        wav(Float32Array.from({ length: 2205 }, (_, i) => 0.1 * Math.sin((i * 440 * Math.PI * 2) / 22050))),
      );
      writeFileSync(
        join(root, 'asset-manifest.json'),
        JSON.stringify({
          images: [{ id: 'fixture-player', file: 'assets/player.png' }],
          audio: [{ id: 'fixture-beep', file: 'assets/beep.wav', loop: false, category: 'sfx' }],
        }),
      );
      writeFileSync(
        join(root, 'game-config.json'),
        JSON.stringify({
          title: 'Synthetic evaluator fixture',
          width: 960,
          height: 640,
          level: { validationToken: 'custom-parameters' },
        }),
      );
      writeFileSync(
        join(root, 'level.mjs'),
        `
export function generateLevel({seed,difficulty,width,height}) {
  return {version:'fixture',seed,difficulty,width,height,duration:4,waves:[{at:1,x:seed%width,y:0,radius:10,speed:{easy:1,normal:2,hard:3}[difficulty],kind:'fixture'}]};
}
export function validateLevel(level, parameters){return {valid:parameters?.validationToken === 'custom-parameters',errors:[]};}
`,
      );
      writeFileSync(
        join(root, 'game.mjs'),
        `
export function createGame({canvas,ctx,assets,emit,level}) {
  const player={x:480,y:320,radius:12}; let time=0,done=false,effectFrames=0;
  return {update(dt,keys) {
    if(done){effectFrames++;return;}
    const x=Number(keys.has('d')||keys.has('arrowright'))-Number(keys.has('a')||keys.has('arrowleft'));
    const y=Number(keys.has('s')||keys.has('arrowdown'))-Number(keys.has('w')||keys.has('arrowup'));
    const n=Math.hypot(x,y)||1;
    player.x=Math.max(12,Math.min(canvas.width-12,player.x+x/n*260*dt));
    player.y=Math.max(12,Math.min(canvas.height-12,player.y+y/n*260*dt));
    time+=dt;
    if(time>=level.duration&&!done){done=true;emit('win',{survivalSeconds:time});}
  }, render(){ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(assets['fixture-player'],player.x-8,player.y-8);},getState(){return {player:{...player},time,effectFrames};}};
}
`,
      );
      const project = createProject('Synthetic evaluator integration', 'Test fixture only');
      const task: any = put('task', {
        id: uid(),
        projectId: project.id,
        kind: 'evaluation',
        instruction: 'Evaluate fixture',
        status: 'running',
        stage: 'evaluation',
        createdAt: now(),
        updatedAt: now(),
      });
      put('build', {
        id: 'synthetic-build',
        projectId: project.id,
        preview: `http://127.0.0.1:${process.env.PREVIEW_PORT}/index.html`,
      });
      const report = await runBrowserEvaluation(task, new AbortController().signal);
      assert.equal(report.total, 14);
      assert.equal(report.passed, report.total, JSON.stringify(report.checks.filter((c) => !c.passed)));
      assert.ok(
        report.checks.find((c) => c.id === 'complete-round')?.evidence.state.effectFrames > 0,
        'ending visuals continue while gameplay time stays frozen',
      );
      const telemetry = list<any>('telemetry', project.id);
      assert.equal(new Set(telemetry.map((e) => e.sessionId)).size, 1);
      assert.equal(telemetry.filter((e) => e.kind === 'start').length, 1);
      assert.equal(telemetry.filter((e) => e.kind === 'win').length, 1);
      assert.ok(
        telemetry.every((e) => e.source === 'script' && e.seed === 1024 && e.difficulty === 'normal'),
      );
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);
