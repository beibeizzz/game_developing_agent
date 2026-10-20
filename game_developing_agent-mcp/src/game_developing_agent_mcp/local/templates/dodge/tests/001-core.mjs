// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import check from 'node:assert/strict';
export const name='development core gameplay';
export const tags=['smoke','mechanics'];
export const covers=['src/scene.js','src/telemetry.js'];
export async function setup(page){
 await page.waitForFunction(()=>window.__phaserGame?.scene.getScene('MeteorScene')?.state==='ready');
 const missing=await page.evaluate(async()=>{const s=window.__phaserGame.scene.getScene('MeteorScene');const manifest=await(await fetch('assets/asset-manifest.json')).json();return manifest.assets.map(a=>a.key).filter(key=>!s.textures.exists(key));});check.deepEqual(missing,[],'declared media loaded');
 if(await page.evaluate(()=>Boolean(window.__phaserGame.scene.getScene('MeteorScene').fx))){const first=await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').fx.frame.name);await page.waitForTimeout(150);check.notEqual(await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').fx.frame.name),first,'imported animation advances frames');}
}
export async function act(page){
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.keyboard.press('Enter');await page.waitForFunction(()=>window.__phaserGame.scene.getScene('MeteorScene').state==='playing');
 const x=await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').player.x);
 await page.keyboard.down('ArrowRight');await page.waitForTimeout(250);await page.keyboard.up('ArrowRight');
 check.ok((await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').player.x))>x+25,'real keyboard moves player');
 await page.waitForFunction(()=>window.__phaserGame.scene.getScene('MeteorScene').obstacles.getLength()>0);
 await page.locator('canvas').screenshot({path:'.playtest/verify/test-run/screenshots/playing.png'});
 await page.keyboard.press('p');const frozen=await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').activeMs);await page.waitForTimeout(220);
 check.equal(await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').activeMs),frozen,'pause freezes active time');
 await page.keyboard.press('p');
 // Fixture positions reach the collision branch; the game performs all damage.
 await page.evaluate(()=>{const s=window.__phaserGame.scene.getScene('MeteorScene');s.player.setPosition(100,450);s.spawn({x:100,radius_px:24,speed_px_s:180});s.obstacles.getChildren().at(-1).y=450;});
 await page.waitForFunction(()=>window.__phaserGame.scene.getScene('MeteorScene').hp===2);
 await page.evaluate(()=>{const s=window.__phaserGame.scene.getScene('MeteorScene');s.spawn({x:100,radius_px:24,speed_px_s:180});s.obstacles.getChildren().at(-1).y=450;});await page.waitForTimeout(160);
 check.equal(await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').hp),2,'invulnerability prevents repeated damage');
 await page.evaluate(()=>{const s=window.__phaserGame.scene.getScene('MeteorScene');s.obstacles.clear(true,true);s.invulnerableUntil=0;s.hp=1;s.spawn({x:100,radius_px:24,speed_px_s:180});s.obstacles.getChildren().at(-1).y=450;});
 await page.waitForFunction(()=>window.__phaserGame.scene.getScene('MeteorScene').state==='loss');
 await page.locator('canvas').screenshot({path:'.playtest/verify/test-run/screenshots/loss.png'});
 await page.keyboard.press('r');check.equal(await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').hp),3);
 await page.evaluate(()=>{const s=window.__phaserGame.scene.getScene('MeteorScene');s.activeMs=59980;s.telemetry.started=performance.now()-59980;s.nextSpawn=s.plan.spawns.length;s.obstacles.clear(true,true);});
 await page.waitForFunction(()=>window.__phaserGame.scene.getScene('MeteorScene').state==='win');
 await page.locator('canvas').screenshot({path:'.playtest/verify/test-run/screenshots/win.png'});
 check.deepEqual(errors,[],'runtime errors');
}
export async function assert(page){
 const rows=await page.evaluate(()=>window.__phaserGame.scene.getScene('MeteorScene').telemetry.rows);
 if(!rows.some(x=>x.event==='end'&&x.outcome==='win'))throw new Error('Win telemetry missing');
 if(!rows.some(x=>x.event==='pause')||!rows.some(x=>x.event==='collision'&&x.damage_applied))throw new Error('Pause/damage telemetry missing');
}
