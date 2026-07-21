#!/usr/bin/env node

/**
 * Build the first 60-second director treatment for Episode 440.
 *
 * This is an editorial review artifact, not a renderer override. It is kept
 * explicit so the team can inspect the causal choices before any image task
 * or Remotion render is dispatched.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(root, process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : 'data/temp/episode-440-director-plan-60s.json')
const referencePlanner = path.resolve(root, '.codex/skills/shot-reference-planner/scripts/build_reference_plan.mjs')

function span(text, start) {
  return { start, end: start + text.length, text }
}

function reference(beat) {
  const input = {
    shot_id: beat.id,
    beat_id: beat.id,
    actor: beat.actorIds[0],
    characters: beat.actorIds,
    event_action: beat.action,
    target: beat.target,
    result: beat.result,
    location: beat.location,
    period: beat.time,
    shot_type: beat.shot.shotType,
    camera_angle: beat.shot.angle,
    lighting: beat.lighting,
    props: beat.props,
  }
  const result = spawnSync(process.execPath, [referencePlanner, '--input', '-'], {
    cwd: root,
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(result.stderr || `reference planner failed for ${beat.id}`)
  const plan = JSON.parse(result.stdout)
  const cafe = plan.queries.find((item) => item.provider === 'shot.cafe')
  const flim = plan.queries.find((item) => item.provider === 'flim.ai')
  return {
    shotCafeQuery: cafe?.url || 'https://shot.cafe/',
    flimQuery: flim?.query || input.event_action,
    transferableRule: [
      plan.derivedVisualRules.framing,
      plan.derivedVisualRules.cameraHeight,
      plan.derivedVisualRules.blocking,
      plan.derivedVisualRules.lightSource,
    ].filter(Boolean).join('；'),
  }
}

const scenes = [
  {
    id: 'S1-yongxiang-consequence',
    location: '长乐宫永巷与囚室',
    time: '西汉初年，夜至次日白天',
    purpose: '用一个正在发生的押送和门后结果建立冷酷开场，而不是先放概念标题。',
    emotionalTurn: '从不安推进到窒息，再把恐惧交给刘盈的反应。',
    characters: ['戚夫人', '宫门守卫', '刘盈'],
    conflict: '戚夫人被吕雉的命令带入永巷，守卫执行命令而不让她回头。',
    anchorAction: '木门被推开、戚夫人被带入、门闩落下，随后刘盈来到门外。',
    exitTransition: '用刘盈的手触门和门内传来的声音，把囚室切到门外反应。',
  },
  {
    id: 'S2-changle-court',
    location: '长乐宫内殿与朝堂通道',
    time: '西汉初年，吕雉执政时期',
    purpose: '把“狠毒”标签落到一个会听奏、作决定、让官员执行的人身上。',
    emotionalTurn: '从个人暴行的余波转入复杂人物的公共权力。',
    characters: ['吕雉', '朝廷官员'],
    conflict: '官员把政务和风险带到吕雉面前，她必须作出会影响他人的决定。',
    anchorAction: '吕雉接过奏牍、按住印玺，走入朝堂，官员让开通道。',
    exitTransition: '印玺落下的声音接到韩信被带入宫门的脚步声。',
  },
  {
    id: 'S3-hanxin-changle',
    location: '长乐宫宫门与内殿',
    time: '公元前196年',
    purpose: '把“诛杀韩信”拍成诱入与封路的具体动作，不用功过分屏。',
    emotionalTurn: '权力从审议转为执行，危险变得不可逆。',
    characters: ['韩信', '吕雉', '宫门守卫'],
    conflict: '韩信以为自己被召入宫，守卫却在身后合上门。',
    anchorAction: '韩信跨过宫门、回头发现退路被封，吕雉的使者展开诏令。',
    exitTransition: '诏令上的印记切到流放路上的车轮和彭越跪地。',
  },
  {
    id: 'S4-pengyue-road',
    location: '洛阳城外流放路',
    time: '西汉初年，白天',
    purpose: '用一次求情与带回行动表现吕雉如何把同情转成政治判断。',
    emotionalTurn: '短暂的求生希望被她的决定反转。',
    characters: ['彭越', '吕雉', '随行侍从'],
    conflict: '彭越跪在车驾前求回故乡，吕雉答应带他回洛阳，却改变了他的命运。',
    anchorAction: '彭越拦车叩首、吕雉掀帘听完、车驾调头返回洛阳。',
    exitTransition: '车轮声与城门声叠到粮税文书，进入“稳定政局”的结果。',
  },
  {
    id: 'S5-court-order',
    location: '长乐宫朝堂',
    time: '西汉初年，吕雉临朝称制时期',
    purpose: '把“坐到棋盘中央”还原成朝堂中的位置、他人的反应和政令流动。',
    emotionalTurn: '从个人狠厉落到制度性影响，留下复杂而非单一的结论。',
    characters: ['吕雉', '朝廷官员', '传令中官', '百姓'],
    conflict: '吕雉的决定必须被官员接收并传到宫外，权力由她的动作变成社会结果。',
    anchorAction: '吕雉走入朝堂、官员俯身、她把诏令交给中官，中官转身传令。',
    exitTransition: '传令声落在百姓领取粮食和听取减负告示的真实反应上。',
  },
]

const beatDefinitions = [
  {
    id: 'B01-door-escort', sceneId: 'S1-yongxiang-consequence', function: 'hook', actorIds: ['戚夫人', '宫门守卫'], target: '永巷囚室木门',
    sourceText: '咱们今天聊的这个人，是中国历史上第一个被骂了两千多年的“毒妇”。', location: '长乐宫永巷', time: '西汉初年，夜间',
    action: '守卫押着戚夫人走到永巷尽头，戚夫人回头挣扎，守卫把她推入囚室。', beforeState: '戚夫人仍在走廊上，门外尚有退路。', afterState: '戚夫人被推入囚室，木门把她与外界隔开。', result: '门外只剩守卫和一扇正在合上的木门，观众先看到命令如何落地。', visualProof: ['戚夫人回头伸手', '守卫推入动作', '木门合拢并露出门闩'], props: ['木门', '门闩'], shot: { shotType: '中远景', angle: '侧后方跟拍', blocking: '守卫在戚夫人两侧形成夹持，木门位于画面前方', camera: '沿走廊向右跟拍后停在门外', transition: '直接切入门内的声音和手部动作' }, lighting: '窄窗冷光与守卫手中的昏黄灯笼', assetStrategy: 'new-static-image', illustrative: true,
  },
  {
    id: 'B02-door-bolt', sceneId: 'S1-yongxiang-consequence', function: 'event', actorIds: ['戚夫人', '宫门守卫'], target: '囚室木栏与门闩',
    sourceText: '她把戚夫人做成人彘，砍断手脚，挖去眼睛，熏聋耳朵，灌哑药，扔进厕所。', location: '永巷囚室', time: '西汉初年，夜间',
    action: '戚夫人抓住木栏向外呼喊，守卫把门闩压下并把刑具放到墙边后离开。', beforeState: '囚室里仍有挣扎和求救，守卫尚未离开。', afterState: '门闩落下，守卫离开，木栏后只留下戚夫人的手和散落衣料。', result: '暴行不靠血腥特写，而由门闩、手、衣料和被遗下的刑具证明。', visualProof: ['手指抓住木栏', '门闩压下', '地面留下破碎衣料和玉簪'], props: ['木栏', '门闩', '破碎衣料', '玉簪'], shot: { shotType: '近景', angle: '门外低机位', blocking: '木栏占前景，手从暗处伸出，守卫只露手臂和背影', camera: '从手部缓慢推到门闩，再落到地面证据', transition: '声音桥接到刘盈脚步' }, lighting: '冷灰石墙，门缝一道硬光，地面湿反光', assetStrategy: 'new-static-image', illustrative: true,
  },
  {
    id: 'B03-liuying-open-door', sceneId: 'S1-yongxiang-consequence', function: 'event', actorIds: ['刘盈', '宫门守卫'], target: '囚室木门',
    sourceText: '她让自己的儿子汉惠帝刘盈去看', location: '永巷厕所门外', time: '西汉初年，白天',
    action: '刘盈走到厕所门外，守卫替他推开半扇木门，刘盈的手停在门框上。', beforeState: '刘盈尚未看见门内，仍以为只是一次例行查看。', afterState: '门缝打开，门内的残破地面和衣料进入他的视线。', result: '门缝成为观众与刘盈共同看到真相的视线桥。', visualProof: ['刘盈手停在门框', '守卫推开半扇门', '门内残破地面进入画面'], props: ['门框', '破碎衣料'], shot: { shotType: '过肩中景', angle: '刘盈肩后主观视角', blocking: '刘盈在左前景，守卫在右侧推门，门缝正对镜头', camera: '跟随刘盈两步后停住，随门缝打开轻推', transition: '门内冷光切到刘盈脸部反应' }, lighting: '走廊暖光被门内冷光切开', assetStrategy: 'new-static-image', illustrative: true,
  },
  {
    id: 'B04-liuying-fall', sceneId: 'S1-yongxiang-consequence', function: 'consequence', actorIds: ['刘盈'], target: '门内惨状与自己的身体',
    sourceText: '结果刘盈当场吓病，从此不理朝政，二十多岁就死了。', location: '永巷厕所门外', time: '西汉初年，白天',
    action: '刘盈看清门内后向后踉跄，手松开门框，膝盖先着地，最后跌坐在走廊上。', beforeState: '刘盈还站在门口，身体保持支撑。', afterState: '刘盈跌坐在地，视线避开门内，守卫不敢上前。', result: '母亲的惩罚直接击穿儿子的身体，后果从门内传到家族内部。', visualProof: ['瞳孔放大', '手从门框滑落', '膝盖着地并跌坐'], props: ['门框', '地面'], shot: { shotType: '中近景', angle: '平视略低', blocking: '刘盈从门边退到画面中央，门内保持虚焦在后景', camera: '先固定捕捉视线，再随他后退短促拉远', transition: '跌地声切到吕雉走过朝堂通道' }, lighting: '脸部由门内冷光覆盖，背景保持暖暗', assetStrategy: 'existing-still', illustrative: true,
  },
  {
    id: 'B05-luzhi-enters-court', sceneId: 'S2-changle-court', function: 'reveal', actorIds: ['吕雉', '朝廷官员'], target: '朝堂通道与官员',
    sourceText: '她叫吕雉，汉高祖刘邦的皇后，中国历史上第一位临朝称制的女性。', location: '长乐宫内殿与朝堂通道', time: '西汉初年，吕雉执政时期',
    action: '吕雉从内殿走入朝堂，官员听见脚步后停止交谈并向两侧退开。', beforeState: '官员聚在通道中央等待，吕雉尚未出现。', afterState: '通道被让出，吕雉走到案前，所有人的视线转向她。', result: '主角由他人的反应被正式确立，不用静态肖像说明她掌权。', visualProof: ['官员停止交谈', '两侧退开', '吕雉走到案前'], props: ['案几', '奏牍'], shot: { shotType: '中远景', angle: '正面低机位', blocking: '官员在两侧形成通道，吕雉从深处向前', camera: '沿通道缓慢后退，让人物走入画面中心', transition: '脚步声延续到奏牍落案' }, lighting: '内殿暖烛光，通道尽头冷光勾勒轮廓', assetStrategy: 'existing-still', illustrative: true,
  },
  {
    id: 'B06-luzhi-petition', sceneId: 'S2-changle-court', function: 'context', actorIds: ['吕雉', '朝廷官员'], target: '奏牍与印玺',
    sourceText: '提起吕雉，很多人脑海里只有两个字：狠毒。但今天我想请你暂时放下这个标签，去看看一个更完整的吕雉。', location: '长乐宫内殿', time: '西汉初年，白天',
    action: '吕雉接过官员递来的奏牍，翻开内容，询问一句后按住印玺，没有立即落印。', beforeState: '“狠毒”的传闻遮住了具体的人，奏牍仍在官员手中。', afterState: '吕雉开始审阅并权衡一份真实政务，人物从标签回到选择。', result: '“放下标签”被转译为她正在处理一件具体政务，而不是让脸被雾化。', visualProof: ['官员递出奏牍', '吕雉翻页停顿', '手按住印玺但未落下'], props: ['奏牍', '印玺'], shot: { shotType: '近景到手部特写', angle: '过肩', blocking: '官员只露肩和手，吕雉与奏牍保持同一视线轴', camera: '从两人关系镜头缓慢推到印玺停住', transition: '印玺的金属声切到宫门脚步' }, lighting: '侧面烛光照亮奏牍和手，脸部不过曝', assetStrategy: 'new-static-image', illustrative: true,
  },
  {
    id: 'B07-hanxin-entered', sceneId: 'S3-hanxin-changle', function: 'event', actorIds: ['韩信', '宫门守卫'], target: '长乐宫宫门与退路',
    sourceText: '她还诛杀了韩信', location: '长乐宫宫门', time: '公元前196年',
    action: '韩信跨过宫门接过召令，回头时发现守卫已经合上门并挡住退路。', beforeState: '韩信以为自己只是入宫受召，身后仍有退路。', afterState: '宫门合拢，守卫封住退路，召令变成不可撤回的拘捕。', result: '“诛杀韩信”先被拍成诱入和封路，观众看见危险如何完成。', visualProof: ['韩信接过召令', '回头发现门合上', '守卫横在退路上'], props: ['召令', '宫门'], shot: { shotType: '中景', angle: '韩信肩后', blocking: '韩信在门内前景，守卫沿门框形成横向阻挡', camera: '跟随跨门后快速小幅拉回，露出已合拢的门', transition: '门闩声切到车轮声' }, lighting: '门外日光强，门内阴影压住退路', assetStrategy: 'new-static-image', illustrative: false,
  },
  {
    id: 'B08-pengyue-plea', sceneId: 'S4-pengyue-road', function: 'event', actorIds: ['彭越', '吕雉', '随行侍从'], target: '吕雉车驾与彭越的流放命运',
    sourceText: '诱杀了彭越', location: '洛阳城外流放路', time: '西汉初年，白天',
    action: '彭越拦住车驾跪地求情，吕雉掀帘听完，命侍从把车驾调头返回洛阳。', beforeState: '彭越在流放路上失去援手，只能追车求生。', afterState: '吕雉答应带他回洛阳，彭越重新看见希望却进入她的决策范围。', result: '“诱杀”被表现为一次看似救援的转向，下一步反转有了动作基础。', visualProof: ['彭越跪地拦车', '吕雉掀帘俯视', '车轮调头扬起尘土'], props: ['车驾', '流放文书'], shot: { shotType: '中远景转近景', angle: '低机位看车驾后切过肩', blocking: '彭越在车前形成阻挡，吕雉在帘后保持高位', camera: '先跟车轮再抬到掀帘动作，最后随车调头横摇', transition: '尘土遮挡转成朝堂文书' }, lighting: '正午硬光与尘土逆光', assetStrategy: 'new-static-image', illustrative: false,
  },
  {
    id: 'B09-relief-order', sceneId: 'S5-court-order', function: 'context', actorIds: ['吕雉', '朝廷官员', '百姓'], target: '政令、粮食与百姓日常',
    sourceText: '但她也稳定了汉初政局，减轻了百姓负担，为后来的文景之治铺了路。', location: '长乐宫外的告示处', time: '西汉初年，白天',
    action: '中官在告示处展开减负文书，官吏按名册分发粮食，百姓从争执转为排队领取。', beforeState: '百姓围在告示处等待，粮食和税负没有明确安排。', afterState: '文书被宣读，官吏按顺序分发，队伍恢复秩序。', result: '文书被宣读后，官吏按名册分发粮食，队伍从混乱变为有序。', visualProof: ['文书展开', '官吏按名册分发', '百姓排队领取'], props: ['告示', '名册', '粮袋'], shot: { shotType: '中景', angle: '平视', blocking: '告示在前景，官吏从左向右分发，百姓队列形成纵深', camera: '沿队列缓慢横移，停在文书和领取动作之间', transition: '纸张翻动声接到朝堂脚步' }, lighting: '户外漫射日光，纸面和粮袋保持自然颜色', assetStrategy: 'new-static-image', illustrative: true,
  },
  {
    id: 'B10-order-center', sceneId: 'S5-court-order', function: 'reveal', actorIds: ['吕雉', '朝廷官员', '传令中官'], target: '长乐宫朝堂的政令流向',
    sourceText: '她是中国历史上第一个真正坐到棋盘中央的女人。而历史，只记住了她掀翻棋盘时的狠。', location: '长乐宫朝堂', time: '西汉初年，吕雉临朝称制时期',
    action: '吕雉走到朝堂案前把诏令交给中官，中官转身穿过俯身的官员向殿外传令。', beforeState: '诏令还在吕雉手中，官员各自等待，不知道执行方向。', afterState: '中官带着诏令离开，官员按她的决定行动，政令从她的位置流向宫外。', result: '诏令离开朝堂，官员转身执行，殿外传令声接上百姓回应。', visualProof: ['吕雉把诏令递出', '中官接令转身', '官员俯身让开通道'], props: ['诏令', '案几', '印玺'], shot: { shotType: '中远景到过肩近景', angle: '低机位侧面', blocking: '吕雉在案前，官员两侧让出通道，中官从前景接令后向外', camera: '从吕雉侧后缓慢推近递令，再跟随中官向外小幅横移', transition: '传令声留在片尾，切黑而不加概念图' }, lighting: '朝堂侧逆光，人物边缘清晰，避免舞台化光束', assetStrategy: 'existing-still', illustrative: true,
  },
]

let cursor = 0
const beats = beatDefinitions.map((beat, index) => {
  const normalized = {
    ...beat,
    sourceSpans: [span(beat.sourceText, cursor)],
    nextBeatId: index < beatDefinitions.length - 1 ? beatDefinitions[index + 1].id : null,
    causalReason: index === 0
      ? '开场用正在执行的押送建立问题，先让观众看到命令造成的后果。'
      : `承接上一 beat 的结果：${beatDefinitions[index - 1].result}`,
  }
  cursor += beat.sourceText.length + 1
  const visualReference = reference(normalized)
  return {
    id: normalized.id,
    sceneId: normalized.sceneId,
    sourceSpans: normalized.sourceSpans,
    function: normalized.function,
    actorIds: normalized.actorIds,
    target: normalized.target,
    action: normalized.action,
    beforeState: normalized.beforeState,
    afterState: normalized.afterState,
    result: normalized.result,
    visualProof: normalized.visualProof,
    causalReason: normalized.causalReason,
    nextBeatId: normalized.nextBeatId,
    shot: { ...normalized.shot, reference: visualReference },
    assetStrategy: normalized.assetStrategy,
    ...(normalized.illustrative ? { illustrative: true } : {}),
    sourceStoryboardIds: index < 6 ? [3599 + Math.min(index, 5)] : index === 6 ? [3604] : index === 7 ? [3604] : index === 8 ? [3604] : [3605],
    location: normalized.location,
    time: normalized.time,
    lighting: normalized.lighting,
    props: normalized.props,
  }
})

const plan = {
  schemaVersion: 1,
  factoryStage: 'director_plan',
  episodeId: 440,
  pilot: { startMs: 0, endMs: 60000, stopBeforeAssetGeneration: true },
  genre: 'historical-biography-docudrama',
  format: '历史人物传记式纪录片 / 影视化历史叙事',
  protagonist: {
    id: '507',
    name: '吕雉',
    arc: '从被迫承受命运的妻子，到通过一次次具体政令与权力选择改变他人处境的皇后；她的狠不是抽象性格标签，而是长期失去安全感后形成的行动方式。',
  },
  dramaticQuestion: '一个被历史称为“毒妇”的女人，如何在真实的家庭创伤与政治选择中成为汉初权力的执行者？',
  thesis: '不替吕雉洗白，也不把她拍成恶魔；让观众通过她对人、文件、门和政令的具体动作，自己看见她如何从受害者变成决策者。',
  scenes,
  beats,
  visualRules: {
    continuityAnchors: [
      '吕雉：同一张脸、同一套汉初宫廷服饰，仅按人生阶段改变妆发与服制。',
      '木门/门闩/奏牍/印玺是动作道具，必须在状态改变时出现，不做装饰。',
      '视线和声音负责跨镜头衔接：门闩声→脚步，印玺声→宫门，车轮声→文书。',
      '同一场次优先保持光向和空间轴；换场用动作桥而不是概念叠化。',
    ],
    forbiddenPatterns: [
      '巨大棋盘、棋子、站在中央的女人、左右功过分屏、抽象空间',
      '只有肖像或空场景，没有正在发生的动作',
      '用同一姿势重复生成两格 temporal sheet',
      '把旁白提到的所有人物同时塞进一张图',
      '把 Shot.Cafe/Flim.ai 参考截图当作最终素材',
    ],
    periodAndStyle: '汉初历史质感，克制的纪录片写实风格；低饱和土红、木色、冷灰石墙，实用光源优先，无现代物件、无画内文字、无水印。',
  },
  reviewNotes: [
    '前 60 秒不按旧分镜 1-7 原样渲染；旧分镜只作为旁白和历史素材索引。',
    'B06、B09、B10 标为 illustrative，是对抽象旁白的可视化桥梁；资产 QC 必须确认画面不会被误读为未经旁白支持的具体史实。',
    '每个 beat 的 reference 只提供构图研究查询，最终资产从已批准静态素材、授权素材或新静态图生成。',
  ],
}

fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`)
console.log(JSON.stringify({ output, episodeId: plan.episodeId, genre: plan.genre, scenes: scenes.length, beats: beats.length, durationMs: plan.pilot.endMs }, null, 2))
