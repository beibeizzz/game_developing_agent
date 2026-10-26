# 编码执行合同

工作目录 /work。最终仅声明真实写入文件和实际执行的测试。
固化文件 shell.mjs、shell.css、index.html、build.mjs、serve.mjs、package.json、blueprint.html 由宿主提供并保持完整。
游戏为本地离线浏览器 ESM 项目，使用 Canvas 2D；资源相对路径。使用 Node 内置测试，保持零游戏运行时依赖。

## Game Coder

实现 game.mjs，导出 createGame({canvas,ctx,config,assets,playAudio,emit,level})，返回 {start(),update(dt,keys),render(),getState()}。
可选返回 onHostEvent(kind,data)，宿主暂停/恢复时调用 onHostEvent('pause',{paused})，供播放状态音效；暂停逻辑由宿主负责。
keys 是小写按键 Set（arrowleft/arrowright/arrowup/arrowdown/w/a/s/d）。宿主负责菜单、暂停、重开、时间循环、难度和 Seed 输入。
游戏仅在 update 时推进。render 绘制背景、角色、障碍、粒子、HUD。getState 返回可序列化状态，包括 player:{x,y,radius}、obstacles、score、survivalSeconds 和状态。
壳在结算后继续调用 update 以推进爆炸等视觉效果；结算后玩法状态、逻辑时间、分数和结局事件保持冻结。暂停时完全停止 update。壳将音频与事件回调绑定当前局，重开后旧局延迟回调自动失效。
碰撞或胜利时 emit('game_over'|'win',{survivalSeconds,score,reason})；每次结局仅发送一次。移动时 emit('move',{x,y}) 可节流到每秒一次。
playAudio(id, enabled=true) 播放声音；playAudio(id,false) 停止指定循环音，移动推进音只在移动时播放。壳自动播放 category=bgm 的循环背景音。
真实使用 asset-manifest.json 内的图片及声音。每个资源通过 ID 取得；可以程序绘制辅助背景/粒子。
game-config.json 包含 title,width,height,playerSpeed,playerRadius,level 与明确的玩法参数。
写 game.test.mjs：导出的纯逻辑函数或无 DOM 的模拟状态测试，覆盖边界、碰撞、操作需求。写 GAME_INTERFACE.md 说明实际实现。
先阅读 contract.json 的 GDD/素材/当前修改要求。保留与本次改动无关的成果。

## Level Coder

独立工作区实现 level.mjs，导出 generateLevel({seed,difficulty,width,height,...parameters})、validateLevel(level, parameters?)。
输出 level={version,seed,difficulty,width,height,duration,waves:[{at,x,y,radius,speed,kind}]}。at 为秒，x/y 为像素，speed 为像素每秒。
固定算法版本、参数、Seed 必须得到相同输出；所有随机数用显式 Seed PRNG。难度 easy/normal/hard。
validateLevel 返回 {valid:boolean,errors:string[]}，验证范围、数值、时间及可避让假设；有界重试后失败需显式报告。游戏壳与蓝图将同一 game-config.json.level 作为第二参数传入，保证参数迭代后的生成和校验口径一致；单参数调用可使用默认参数。
写 level.test.mjs，覆盖 Seed 重现、不同 Seed、三种难度及失败输入。写 LEVEL_INTERFACE.md 说明验证假设。
游戏运行和蓝图读取同一个 level.mjs，参数来源 game-config.json.level。关卡接口与已实现游戏兼容。
关卡参数变更写入本工作区 game-config.json.level；宿主交接时仅合并 level 字段，游戏名称、画布、玩家等字段由 Game Coder 管理。保持这些字段原值。

## 交付

运行 npm test、npm run build。最终结构化输出 summary、files 字符串数组、testsPassed 布尔值、interface 字符串。
依赖已有 Node 内置模块。代码保持 /work 内。密钥和执行器配置由运行服务管理。
