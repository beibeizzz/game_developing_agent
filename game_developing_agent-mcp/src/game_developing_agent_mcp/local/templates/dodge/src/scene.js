// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import {Telemetry} from './telemetry.js';
import assetManifest from '../assets/asset-manifest.json';
const Phaser=globalThis.Phaser;
export default class MeteorScene extends Phaser.Scene{
 constructor(){super('MeteorScene');}
 preload(){this.load.json('spec','game-spec.json');for(let i=1;i<=9;i++)this.load.json(`stage_${i}`,`levels/stage_${i}.json`);for(const file of assetManifest.assets){if(!file.frameWidth)this.load.image(file.key,file.path);else this.load.spritesheet(file.key,file.path,{frameWidth:file.frameWidth,frameHeight:file.frameHeight,endFrame:file.frames-1});}}
 create(){
  this.spec=this.cache.json.get('spec');this.telemetry=new Telemetry(this.spec);this.activeMs=0;this.state='ready';this.hp=this.spec.round.initial_hp;this.invulnerableUntil=0;this.nextSpawn=0;
  this.obstacles=this.add.group();this.stars=[];if(this.textures.exists('background'))this.add.image(400,300,'background').setDisplaySize(800,800).setAlpha(.55);this.bg=this.add.graphics();
  for(let i=0;i<95;i++)this.stars.push({x:(i*173+61)%800,y:(i*97+19)%600,r:i%3===0?1.4:.7});
  this.player=this.add.container(this.spec.player.start_x,this.spec.player.start_y);let hull;if(this.textures.exists('player')){hull=this.add.image(0,0,'player');}else{hull=this.add.graphics();hull.fillStyle(0x5de6e7);hull.fillTriangle(0,-20,-14,15,14,15);hull.fillStyle(0xd7ffff);hull.fillTriangle(0,-12,-5,8,5,8);}this.flame=this.add.graphics();this.player.add([this.flame,hull]);
  if(this.textures.exists('thruster')){const asset=assetManifest.assets.find(a=>a.key==='thruster');this.anims.create({key:'thruster-loop',frames:this.anims.generateFrameNumbers('thruster',{start:0,end:asset.frames-1}),frameRate:asset.fps,repeat:-1});this.fx=this.add.sprite(0,27,'thruster').setScale(.7).play('thruster-loop');this.player.addAt(this.fx,0);this.flame.setVisible(false);}
  this.hud=this.add.text(24,20,'',{fontFamily:'sans-serif',fontSize:`${this.spec.ui?.hp_font_size||22}px`,color:'#dceeff'}).setDepth(10);
  this.timer=this.add.text(776,20,'60.0',{fontFamily:'monospace',fontSize:'26px',color:'#8bebdf'}).setOrigin(1,0).setDepth(10);
  this.progress=this.add.graphics().setDepth(9);this.overlay=this.add.container(400,285).setDepth(20);const panel=this.add.rectangle(0,0,440,180,0x10223a,.95).setStrokeStyle(1,0x385d7d);this.message=this.add.text(0,-25,'READY / 准备出发',{fontFamily:'sans-serif',fontSize:'28px',color:'#f1faff',align:'center'}).setOrigin(.5);this.subtitle=this.add.text(0,32,'Enter 开始 · WASD / 方向键移动',{fontFamily:'sans-serif',fontSize:'16px',color:'#9eb7cf',align:'center'}).setOrigin(.5);this.overlay.add([panel,this.message,this.subtitle]);
  this.keys=this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT');
  this.input.keyboard.on('keydown-ENTER',()=>this.startRound());this.input.keyboard.on('keydown-P',()=>this.togglePause());this.input.keyboard.on('keydown-R',()=>this.startRound());
  document.querySelector('#start').onclick=()=>this.startRound();document.querySelector('#pause').onclick=()=>this.togglePause();document.querySelector('#restart').onclick=()=>this.startRound();document.querySelector('#export').onclick=()=>this.telemetry.export();
  this.game.events.on('blur',()=>{if(this.state==='playing')this.togglePause();});
  window.addEventListener('beforeunload',()=>{if(['playing','paused'].includes(this.state))this.telemetry.record('end',this.activeMs,{outcome:'quit'});});
  this.updateHud();
 }
 startRound(){
  this.fx?.anims.resume();
  if(['playing','paused'].includes(this.state))this.telemetry.record('end',this.activeMs,{outcome:'restart'});
  this.difficulty=document.querySelector('#difficulty').value;this.seed=Number(document.querySelector('#seed').value);
  const index=['easy','normal','hard'].indexOf(this.difficulty)*3+this.spec.level_factory.seeds.indexOf(this.seed)+1;
  this.plan=this.cache.json.get(`stage_${index}`).content.data;this.activeMs=0;this.hp=this.spec.round.initial_hp;this.invulnerableUntil=0;this.nextSpawn=0;this.obstacles.clear(true,true);this.player.setPosition(this.spec.player.start_x,this.spec.player.start_y).setAlpha(1);this.state='playing';this.overlay.setVisible(false);this.telemetry.begin(this.difficulty,this.seed);this.telemetry.record('enter',0);this.updateHud();
 }
 togglePause(){if(this.state==='playing'){this.state='paused';this.fx?.anims.pause();this.overlay.setVisible(true);this.message.setText('PAUSED / 已暂停');this.subtitle.setText('P 继续 · R 重新开始');this.telemetry.record('pause',this.activeMs);}else if(this.state==='paused'){this.state='playing';this.fx?.anims.resume();this.overlay.setVisible(false);this.telemetry.record('resume',this.activeMs);}}
 finish(outcome){if(this.state!=='playing')return;this.state=outcome;this.overlay.setVisible(true);this.message.setText(outcome==='win'?'SURVIVED / 生存成功':'MISSION ENDED / 挑战结束');this.subtitle.setText(`坚持 ${(this.activeMs/1000).toFixed(1)} 秒 · R 再试一次`);this.telemetry.record('end',this.activeMs,{outcome,hp:this.hp});this.updateHud();}
 spawn(s){let meteor;if(this.textures.exists('obstacle')){meteor=this.add.image(s.x,-s.radius_px,'obstacle').setDisplaySize(s.radius_px*2,s.radius_px*2);}else{meteor=this.add.graphics({x:s.x,y:-s.radius_px});meteor.fillStyle(0xa8755e);meteor.fillCircle(0,0,s.radius_px);meteor.lineStyle(2,0xf2c496);meteor.strokeCircle(0,0,s.radius_px);meteor.fillStyle(0x714b45);meteor.fillCircle(-s.radius_px*.25,-s.radius_px*.2,s.radius_px*.3);meteor.fillCircle(s.radius_px*.35,s.radius_px*.3,s.radius_px*.22);}meteor.setData({radius:s.radius_px,speed:s.speed_px_s});this.obstacles.add(meteor);}
 updateHud(){this.hud.setText(`生命 ${'● '.repeat(this.hp)}${'○ '.repeat(this.spec.round.initial_hp-this.hp)}`);this.timer.setText(Math.max(0,(this.spec.round.duration_ms-this.activeMs)/1000).toFixed(1));this.progress.clear().fillStyle(0x1b334b).fillRect(24,57,752,3).fillStyle(0x5de6e7).fillRect(24,57,752*Math.min(1,this.activeMs/this.spec.round.duration_ms),3);}
 update(time,delta){
  this.bg.clear();for(const star of this.stars){this.bg.fillStyle(0x7599bd,star.r>1?.55:.3);this.bg.fillCircle(star.x,(star.y+this.activeMs*.014)%600,star.r);}
  this.flame.clear().fillStyle(0xfac777).fillTriangle(-6,13,6,13,0,28+Math.sin(this.activeMs*.03)*5);
  if(this.state!=='playing')return;
  const dt=Math.min(delta,100);this.activeMs=Math.min(this.spec.round.duration_ms,this.activeMs+dt);
  let dx=Number(this.keys.D.isDown||this.keys.RIGHT.isDown)-Number(this.keys.A.isDown||this.keys.LEFT.isDown),dy=Number(this.keys.S.isDown||this.keys.DOWN.isDown)-Number(this.keys.W.isDown||this.keys.UP.isDown);const norm=Math.hypot(dx,dy)||1;
  this.player.x=Phaser.Math.Clamp(this.player.x+dx/norm*this.spec.player.speed_px_s*dt/1000,16,784);this.player.y=Phaser.Math.Clamp(this.player.y+dy/norm*this.spec.player.speed_px_s*dt/1000,80,580);
  while(this.nextSpawn<this.plan.spawns.length&&this.plan.spawns[this.nextSpawn].time_ms<=this.activeMs)this.spawn(this.plan.spawns[this.nextSpawn++]);
  for(const meteor of this.obstacles.getChildren().slice()){
   meteor.y+=meteor.getData('speed')*dt/1000;meteor.rotation+=dt*.00025;
   if(meteor.y-meteor.getData('radius')>600){this.obstacles.remove(meteor,true,true);continue;}
   if(Math.hypot(meteor.x-this.player.x,meteor.y-this.player.y)<meteor.getData('radius')+this.spec.player.radius_px){
    const applied=this.activeMs>=this.invulnerableUntil;if(applied){this.hp=Math.max(0,this.hp-this.spec.round.collision_damage);this.invulnerableUntil=this.activeMs+this.spec.round.invulnerability_ms;this.cameras.main.shake(100,.003);}
    if(!meteor.getData('collisionRecorded')){this.telemetry.record('collision',this.activeMs,{hp:this.hp,damage_applied:applied});meteor.setData('collisionRecorded',true);}
    if(applied)this.obstacles.remove(meteor,true,true);
    if(this.hp===0){this.finish('loss');break;}
   }
  }
  this.player.setAlpha(this.activeMs<this.invulnerableUntil?(Math.floor(this.activeMs/80)%2?.3:1):1);
  this.updateHud();if(this.activeMs>=this.spec.round.duration_ms&&this.state==='playing')this.finish('win');
 }
}
