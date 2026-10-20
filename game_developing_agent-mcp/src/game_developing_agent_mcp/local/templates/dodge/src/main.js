// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import Phaser from 'phaser';
globalThis.Phaser=Phaser;
const {default:MeteorScene}=await import('./scene.js');
window.__phaserGame=new Phaser.Game({type:Phaser.AUTO,parent:'game',width:800,height:600,backgroundColor:'#091326',scale:{mode:Phaser.Scale.FIT,autoCenter:Phaser.Scale.CENTER_BOTH},scene:[MeteorScene],render:{antialias:true}});
