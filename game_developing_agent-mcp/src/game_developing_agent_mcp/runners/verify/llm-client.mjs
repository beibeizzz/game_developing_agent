#!/usr/bin/env node
// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
/**
 * llm-client.mjs — shared multimodal LLM client for game-verify scripts.
 *
 * One entry point, `callModel(...)`, that sends the pinned Doubao 2.0 model
 * to Volcengine ARK.
 *
 * Transport:
 *   - 'ark-doubao' : ARK OpenAI-compatible endpoint.
 *
 * callModel({ prompt, images, video, ... }) ->
 *   { text, usage, finishReason, attempts } |
 *   { error, errorKind: api|network|response|config|filesystem|executor, retryable, attempts }
 *   images: [{ path }] or [{ mimeType, data(base64) }]
 *   video:  { path } | string path (optional)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

export const DOUBAO_VLM_MODEL = 'doubao-seed-2.1-pro';

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── .env autoload (matches generate_image.py's _load_dotenv convention) ───
// Search upward from cwd and this module for a .env; set vars that aren't
// already in the real environment (real env always wins).
function loadDotenvOnce() {
  if (globalThis.__game_developing_agentDotenvLoaded) return;
  globalThis.__game_developing_agentDotenvLoaded = true;
  const candidates = [];
  let dir = process.cwd();
  for (let i = 0; i < 7; i++) { candidates.push(join(dir, '.env')); dir = resolve(dir, '..'); }
  try { let md = dirname(new URL(import.meta.url).pathname); for (let i = 0; i < 7; i++) { candidates.push(join(md, '.env')); md = resolve(md, '..'); } } catch {}
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      for (const raw of readFileSync(p, 'utf-8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) process.env[key] = val;
      }
    } catch {}
  }
}
loadDotenvOnce();

/**
 * Decide which provider to use.
 * Priority: explicit arg > env GAME_VERIFY_PROVIDER > auto.
 * Only the ARK transport is supported.
 */
export function detectProvider({ provider, model } = {}) {
  const explicit = provider || process.env.GAME_VERIFY_PROVIDER;
  if (explicit && explicit !== 'ark-doubao') return null;
  if (model && model !== DOUBAO_VLM_MODEL) return null;
  if (process.env.ARK_AGENT_PLAN_API_KEY) return 'ark-doubao';
  return null; // caller should fall back to a non-LLM policy
}

// ── Media helpers ────────────────────────────────────────────────────────
function imageMime(p) {
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(p).toLowerCase()] || 'image/png';
}
function videoMime(p) {
  return { '.webm': 'video/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' }[extname(p).toLowerCase()] || 'video/webm';
}
function asInlineMedia(item, kindMime) {
  if (!item) return null;
  if (typeof item === 'string') item = { path: item };
  if (item.data && item.mimeType) return { mimeType: item.mimeType, data: item.data };
  if (item.path) {
    const buf = readFileSync(resolve(item.path));
    return { mimeType: item.mimeType || kindMime(item.path), data: buf.toString('base64') };
  }
  return null;
}

// One isolated Claude Code task via the existing Python VLM bridge.
export async function callModel(opts={}) {
  const {prompt,images=[],video=null,maxTokens=2048,timeout=120,retries=0}=opts;
  if(!detectProvider({provider:opts.provider,model:opts.model}))return {error:'Plan vision credentials/model missing',errorKind:'config',retryable:false,attempts:0};
  if(retries!==0)return {error:'Vision retries require a new explicit task',errorKind:'config',retryable:false,attempts:0};
  const content=[{type:'text',text:prompt}];
  for(const item of images){const m=asInlineMedia(item,imageMime);if(m)content.push({type:'image_url',image_url:{url:'data:'+m.mimeType+';base64,'+m.data}});}
  if(video){const m=asInlineMedia(video,videoMime);content.push({type:'video_url',video_url:{url:'data:'+m.mimeType+';base64,'+m.data}});}
  return await new Promise(resolveResult=>{
    const child=spawn(process.env.GAME_DEVELOPING_AGENT_PYTHON_EXECUTABLE||'python3',['-m','game_developing_agent_mcp.local.vision'],{stdio:['pipe','pipe','pipe']});let out='';let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolveResult(value);};
    const timer=setTimeout(()=>{child.kill('SIGTERM');finish({error:'Vision task timed out; usage record retained',errorKind:'timeout',retryable:false,attempts:1});},(timeout+30)*1000);
    child.stdout.on('data',d=>{out+=d;});child.stderr.resume();
    child.on('error',()=>finish({error:'Could not launch Python vision bridge',errorKind:'executor',retryable:false,attempts:0}));
    child.on('close',()=>{try{finish({...JSON.parse(out),attempts:1,provider:'claude_code_vision_task'});}catch{finish({error:'Vision bridge returned invalid JSON',errorKind:'response',retryable:false,attempts:1});}});
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({content,max_tokens:maxTokens,timeout,project:process.cwd()}));
  });
}

/** Best-effort JSON extraction from a model reply (handles ```json fences and prose). */
export function extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch {}
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const slice = t.slice(first, last + 1);
    try { return JSON.parse(slice); } catch {}
  }
  return null;
}
