// Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import { defineConfig } from 'vite';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
export default defineConfig({
  base: './',
  plugins: [{name: 'ship-levels', closeBundle() {
    mkdirSync('dist/levels', {recursive: true});
    cpSync('levels', 'dist/levels', {recursive: true});
    cpSync('game-spec.json', 'dist/game-spec.json');
    const manifest=JSON.parse(readFileSync('assets/asset-manifest.json','utf8'));
    mkdirSync('dist/assets',{recursive:true});cpSync('assets/asset-manifest.json','dist/assets/asset-manifest.json');
    for(const asset of manifest.assets){
      const path=asset.path;
      mkdirSync(dirname('dist/'+path),{recursive:true});cpSync(path,'dist/'+path);
    }
  }}]
});
