// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {generate,RNG_VERSION,GENERATOR_VERSION} from '../src/waves.ts';
test('all nine authored plans reproduce and preserve corridor, timing and active count',()=>{
 for(let i=1;i<=9;i++){
  const {content:{data:d}}=JSON.parse(readFileSync(`levels/stage_${i}.json`));
  const p=d.params;assert.deepEqual(generate(d.seed,d.rngVersion,d.generatorVersion,p),d.spawns);
  for(const s of d.spawns){
   assert.ok(s.time_ms>=p.minimum_reaction_ms&&s.time_ms<p.duration_ms);
   assert.ok(s.x-s.radius_px>=0&&s.x+s.radius_px<=p.width);
   assert.ok(Math.abs(s.x-p.width/2)-s.radius_px>=p.safety_gap_px/2-1);
   assert.ok(s.speed_px_s>=p.speed_px_s_range[0]&&s.speed_px_s<=p.speed_px_s_range[1]);
   const alive=d.spawns.filter(t=>t.time_ms<=s.time_ms&&t.time_ms+(p.height+2*t.radius_px)/t.speed_px_s*1000>s.time_ms);assert.ok(alive.length<=p.max_alive_obstacles);
  }
 }
});
test('unsupported inputs fail before producing a level',()=>{
 const p=JSON.parse(readFileSync('levels/stage_1.json')).content.data.params;
 assert.throws(()=>generate(42,'unknown',GENERATOR_VERSION,p));
 assert.throws(()=>generate(42,RNG_VERSION,GENERATOR_VERSION,{...p,spawn_interval_ms:0}));
 assert.throws(()=>generate(-1,RNG_VERSION,GENERATOR_VERSION,p));
});
