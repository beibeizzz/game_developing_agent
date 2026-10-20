// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {generate,RNG_VERSION,GENERATOR_VERSION} from '../src/waves.ts';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{difficulty:{type:'string'},seed:{type:'string'}}});
const spec=JSON.parse(readFileSync('game-spec.json','utf8'));
const engine=JSON.parse(readFileSync('node_modules/phaser/package.json','utf8')).version;
mkdirSync('levels',{recursive:true});
let index=0;
let written=0;
if(values.difficulty&&!['easy','normal','hard'].includes(values.difficulty))throw new Error('Unknown difficulty');
if(values.seed!==undefined&&!spec.level_factory.seeds.includes(Number(values.seed)))throw new Error('Unknown seed');
for(const difficulty of ['easy','normal','hard']) for(const seed of spec.level_factory.seeds){
  index++;
  if(values.difficulty&&values.difficulty!==difficulty)continue;
  if(values.seed!==undefined&&Number(values.seed)!==seed)continue;
  const params={...spec.level_factory,...spec.level_factory.difficulty_params[difficulty],duration_ms:spec.round.duration_ms,width:spec.viewport.width,height:spec.viewport.height,player_radius_px:spec.player.radius_px};
  delete params.difficulty_params;delete params.seeds;delete params.rngVersion;delete params.generatorVersion;
  const data={project_id:spec.project_id,...spec.revisions,difficulty,seed,rngVersion:RNG_VERSION,generatorVersion:GENERATOR_VERSION,engineVersion:engine,params,spawns:generate(seed,RNG_VERSION,GENERATOR_VERSION,params)};
  const stage={level_id:`stage_${index}`,name:`${difficulty} · ${seed}`,genre:'bullet_hell',difficulty,length:0,unlock_mode:'open',next_level:null,win_condition:{kind:'survive_time',value:spec.round.duration_ms/1000},lose_condition:{kind:'lives_zero'},content:{kind:'dodge_waves_v1',data}};
  writeFileSync(`levels/${stage.level_id}.json`,JSON.stringify(stage,null,2)+'\n');
  written++;
}
console.log(JSON.stringify({levels:written,rng:RNG_VERSION,generator:GENERATOR_VERSION,phaser:engine}));
