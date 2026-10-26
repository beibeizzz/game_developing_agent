import { createGame } from './game.mjs';
import { generateLevel, validateLevel } from './level.mjs';
const $ = (id) => document.getElementById(id);
const config = await fetch('game-config.json').then((r) => r.json());
const manifest = await fetch('asset-manifest.json').then((r) => r.json());
const canvas = $('game'),
  ctx = canvas.getContext('2d');
canvas.width = config.width || 960;
canvas.height = config.height || 600;
document.title = config.title;
$('title').textContent = config.title;
const assets = {},
  sounds = {},
  playing = new Set();
let muted = false;
await Promise.all(
  manifest.images.map(async (a) => {
    const img = new Image();
    img.src = a.file;
    try {
      await img.decode();
    } catch {
      throw new Error(`图片加载失败：${a.id} (${a.file})`);
    }
    assets[a.id] = img;
  }),
);
await Promise.all(
  manifest.audio.map(
    (a) =>
      new Promise((resolve, reject) => {
        const audio = new Audio();
        sounds[a.id] = audio;
        audio.loop = !!a.loop;
        audio.volume = a.loop ? 0.18 : 0.55;
        audio.preload = 'auto';
        const timeout = setTimeout(() => reject(new Error(`音频加载超时：${a.id}`)), 15000);
        audio.onloadeddata = () => {
          clearTimeout(timeout);
          resolve();
        };
        audio.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`音频加载失败：${a.id} (${a.file})`));
        };
        audio.src = a.file;
        audio.load();
      }),
  ),
);
const keys = new Set();
let sessionId = crypto.randomUUID(),
  seed = 1024,
  difficulty = 'normal',
  started = false,
  paused = false,
  ended = false,
  elapsed = 0,
  game,
  level;
const params = new URLSearchParams(location.search);
const source = params.get('source') === 'script' ? 'script' : 'human';
const project = params.get('project'),
  build = params.get('build');
function emit(kind, data = {}) {
  const message = {
    type: 'game-agent:event',
    projectId: project,
    buildId: build,
    sessionId,
    source,
    seed,
    difficulty,
    kind,
    data,
    at: new Date().toISOString(),
  };
  if (window.parent !== window) window.parent.postMessage(message, '*');
  try {
    const log = JSON.parse(localStorage.getItem('game-agent-telemetry') || '[]');
    log.push(message);
    localStorage.setItem('game-agent-telemetry', JSON.stringify(log.slice(-2000)));
  } catch (e) {
    $('error').textContent = '本地试玩记录保存失败：' + String(e);
  }
  if (kind === 'game_over' || kind === 'win') {
    ended = true;
    started = false;
    $('status').textContent = kind === 'win' ? '本局完成 · R 再来一局' : '游戏结束 · R 再来一局';
    for (const audio of Object.values(sounds)) if (audio.loop) audio.pause();
  }
}
function playAudio(id, enabled = true) {
  if (!sounds[id]) return;
  const a = sounds[id];
  if (!enabled) {
    playing.delete(id);
    a.pause();
    return;
  }
  playing.add(id);
  if (muted) return;
  if (!a.loop) a.currentTime = 0;
  if (a.paused) a.play().catch(() => {});
}
function stopAudio() {
  for (const a of Object.values(sounds)) a.pause();
}
function start() {
  stopAudio();
  playing.clear();
  sessionId = crypto.randomUUID();
  seed = Number($('seed').value) || 0;
  difficulty = $('difficulty').value;
  elapsed = 0;
  lastTelemetry = 0;
  paused = false;
  ended = false;
  keys.clear();
  level = generateLevel({ ...config.level, seed, difficulty, width: canvas.width, height: canvas.height });
  const validation = validateLevel(level, config.level || {});
  if (!validation.valid) throw Error('关卡验证失败：' + JSON.stringify(validation.errors));
  const activeSession = sessionId;
  game = createGame({
    canvas,
    ctx,
    config,
    assets,
    level,
    playAudio: (id, enabled = true) => {
      if (sessionId === activeSession) playAudio(id, enabled);
    },
    emit: (kind, data) => {
      if (sessionId === activeSession) emit(kind, data);
    },
  });
  started = true;
  game.start?.();
  $('status').textContent = '躲避障碍，保持移动';
  canvas.focus();
  emit('start', { generatorVersion: level.version || '1', config });
  for (const a of manifest.audio) if (a.loop && a.category === 'bgm') playAudio(a.id);
}
function pause() {
  if (!started) return;
  paused = !paused;
  keys.clear();
  $('status').textContent = paused ? '已暂停 · P 继续' : '躲避障碍，保持移动';
  emit('pause', { paused });
  if (paused) stopAudio();
  else for (const a of manifest.audio) if (a.loop && a.category === 'bgm') playAudio(a.id);
  game.onHostEvent?.('pause', { paused });
}
function safely(fn) {
  try {
    fn();
  } catch (e) {
    $('error').textContent = String(e);
    emit('error', { message: String(e) });
  }
}
$('start').onclick = () => safely(start);
$('restart').onclick = () =>
  safely(() => {
    emit('restart', { elapsed });
    start();
  });
$('pause').onclick = pause;
$('mute').onclick = () => {
  muted = !muted;
  $('mute').textContent = '声音：' + (muted ? '关' : '开');
  if (muted) stopAudio();
  else if (started && !paused) for (const id of playing) if (sounds[id].loop) playAudio(id);
};
window.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  if (!e.repeat) {
    if (e.key === 'Enter') safely(start);
    if (e.key.toLowerCase() === 'p') pause();
    if (e.key.toLowerCase() === 'r') $('restart').click();
  }
  keys.add(e.key.toLowerCase());
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => {
  keys.clear();
  if (started && !paused) pause();
});
document.querySelectorAll('[data-key]').forEach((b) => {
  b.onpointerdown = (e) => {
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    keys.add(b.dataset.key.toLowerCase());
  };
  b.onpointerup = () => keys.delete(b.dataset.key.toLowerCase());
  b.onpointercancel = b.onpointerup;
});
let last = performance.now(),
  lastTelemetry = 0;
function frame(t) {
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;
  try {
    if (started && !paused && !ended) {
      elapsed += dt;
      game.update(dt, keys);
      if (elapsed - lastTelemetry >= 1) {
        emit('tick', { elapsed, ...game.getState() });
        lastTelemetry = elapsed;
      }
    } else if (ended && !paused) game.update(dt, new Set());
    if (game) game.render();
    else {
      ctx.fillStyle = '#0b1428';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#8ad4ff';
      ctx.font = '24px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('按 Enter 开始', canvas.width / 2, canvas.height / 2);
    }
    $('score').textContent = `${elapsed.toFixed(1)} 秒 · Seed ${seed}`;
  } catch (e) {
    started = false;
    $('error').textContent = String(e);
    emit('error', { message: String(e) });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// Observable state supports independent browser regression. Game logic remains in game.mjs.
window.__game = {
  getState: () => ({ started, paused, ended, elapsed, seed, difficulty, level, state: game?.getState() }),
  start: () => safely(start),
  pause,
};
