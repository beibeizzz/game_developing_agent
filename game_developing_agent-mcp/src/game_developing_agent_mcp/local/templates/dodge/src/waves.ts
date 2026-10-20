// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
export type Params = {
  duration_ms: number; width: number; height: number;
  spawn_interval_ms: number; speed_px_s_range: [number, number];
  obstacle_radius_px_range: [number, number]; max_alive_obstacles: number;
  player_radius_px: number; safety_gap_px: number; minimum_reaction_ms: number;
};
export type Spawn = {time_ms: number; x: number; radius_px: number; speed_px_s: number};
export const RNG_VERSION = 'mulberry32-v1';
export const GENERATOR_VERSION = 'dodge-waves-v1';
export function generate(seed: number, rngVersion: string, generatorVersion: string, p: Params): Spawn[] {
  if (rngVersion !== RNG_VERSION || generatorVersion !== GENERATOR_VERSION) throw new Error('Unsupported generator/RNG version');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be uint32');
  for (const value of [p.duration_ms,p.width,p.height,p.spawn_interval_ms,p.max_alive_obstacles,p.player_radius_px,p.safety_gap_px,p.minimum_reaction_ms,...p.speed_px_s_range,...p.obstacle_radius_px_range]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('Parameters must be finite positive numbers');
  }
  if (p.duration_ms > 60000 || p.spawn_interval_ms < 100 || p.max_alive_obstacles > 12 || !Number.isInteger(p.max_alive_obstacles)) throw new Error('Unsupported wave limits');
  if (p.speed_px_s_range[0] > p.speed_px_s_range[1] || p.obstacle_radius_px_range[0] > p.obstacle_radius_px_range[1]) throw new Error('Reversed range');
  const safeWidth = Math.max(p.safety_gap_px,2*p.player_radius_px+8);
  const leftEnd = p.width/2-safeWidth/2;
  if (leftEnd < 2*p.obstacle_radius_px_range[1]) throw new Error('Arena too narrow for safety corridor');
  let state = seed >>> 0;
  const random = () => { state=(state+0x6d2b79f5)>>>0; let t=state; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
  const result: Spawn[]=[];
  for (let time_ms=p.minimum_reaction_ms;time_ms<p.duration_ms;time_ms+=p.spawn_interval_ms) {
    const alive=result.filter(s=>s.time_ms+(p.height+2*s.radius_px)/s.speed_px_s*1000>time_ms).length;
    if (alive>=p.max_alive_obstacles) continue;
    const radius_px=Math.round(p.obstacle_radius_px_range[0]+random()*(p.obstacle_radius_px_range[1]-p.obstacle_radius_px_range[0]));
    const speed_px_s=Math.round(p.speed_px_s_range[0]+random()*(p.speed_px_s_range[1]-p.speed_px_s_range[0]));
    const side=random()<0.5;
    const xLeft=radius_px+random()*(leftEnd-2*radius_px);
    const x=Math.round(side?xLeft:p.width-xLeft);
    result.push({time_ms,x,radius_px,speed_px_s});
  }
  return result;
}
