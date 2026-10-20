// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
const STORAGE='game_developing_agent-meteor-telemetry-v1';
export class Telemetry{
 constructor(spec){this.spec=spec;try{this.rows=JSON.parse(localStorage.getItem(STORAGE)||'[]');if(!Array.isArray(this.rows))this.rows=[];}catch{this.rows=[];}}
 begin(difficulty,seed){this.id=crypto.randomUUID();this.started=performance.now();this.difficulty=difficulty;this.seed=seed;}
 record(event,active,extra={}){
  if(!this.id)return;
  const row={project_id:this.spec.project_id,run_id:this.spec.run_id,play_session_id:this.id,...this.spec.revisions,seed:this.seed,difficulty:this.difficulty,event,elapsed_active_ms:Math.round(active),elapsed_wall_ms:Math.round(performance.now()-this.started),...extra};
  this.rows.push(row);
  try{localStorage.setItem(STORAGE,JSON.stringify(this.rows));}catch{document.querySelector('#notice').textContent='本地存储已满，请导出试玩记录。';}
  if(new URLSearchParams(location.search).get('game_developing_agent_telemetry')==='1'){
   fetch('/__game_developing_agent/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(row),keepalive:true}).then(r=>{if(!r.ok)document.querySelector('#notice').textContent='服务端记录保存失败，试玩数据仍可从浏览器导出。';}).catch(()=>{document.querySelector('#notice').textContent='连接中断，试玩数据仍可从浏览器导出。';});
  }
 }
 export(){const blob=new Blob([this.rows.map(r=>JSON.stringify(r)).join('\n')+'\n'],{type:'application/x-ndjson'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='meteor-playtest.jsonl';a.click();URL.revokeObjectURL(a.href);}
}
