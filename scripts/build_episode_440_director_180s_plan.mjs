#!/usr/bin/env node

/**
 * Extend the approved Episode 440 director treatment from 60s to 180s.
 *
 * This is an editorial artifact only. It adds concrete, causal event beats;
 * it does not create image layers, cards, I2V prompts, or renderer state.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const sourceFile = path.resolve(root, 'data/temp/episode-440-director-plan-60s.json')
const outputFile = path.resolve(root, process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : 'data/temp/episode-440-director-plan-180s.json')
const referencePlanner = path.resolve(root, '.codex/skills/shot-reference-planner/scripts/build_reference_plan.mjs')

const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'))

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
    flimQuery: flim?.query || beat.action,
    transferableRule: [
      plan.derivedVisualRules.framing,
      plan.derivedVisualRules.cameraHeight,
      plan.derivedVisualRules.blocking,
      plan.derivedVisualRules.lightSource,
    ].filter(Boolean).join('；'),
  }
}

function span(text, start) {
  return { start, end: start + text.length, text }
}

const extensionScenes = [
  {
    id: 'S6-young-luzhi-home',
    location: '吕家旧宅窗前与院门',
    time: '吕雉少女时期，迁居前的白天',
    purpose: '让观众先看到婚姻和权力之前的吕雉，以及她被家庭决定打断的日常。',
    emotionalTurn: '安静做针线转为听见车轮、意识到家中要搬迁。',
    conflict: '吕雉的生活由父亲安排，她只能从窗前看着变化发生。',
    anchorAction: '吕雉放下丝线，站起身望向院门外的车队。',
    exitTransition: '车轮声接入沛县城门，画面从室内暖光切到迁徙尘土。',
    characters: ['吕雉', '吕家人'],
  },
  {
    id: 'S7-pei-family-arrival',
    location: '沛县城门与吕家车队',
    time: '吕公一家迁入沛县的黄昏',
    purpose: '交代吕家进入沛县，给吕雉遇见刘邦建立空间和时间起点。',
    emotionalTurn: '躲避仇家的仓促迁徙转为在陌生县城落脚。',
    conflict: '吕家要在陌生地方重新安置，家人和行李都挤在狭窄车厢里。',
    anchorAction: '吕公驾车穿过城门，吕雉掀帘查看街道，车队在客舍前停下。',
    exitTransition: '城门喧声接到宴席酒碗落桌声，吕公第一次看见刘邦。',
    characters: ['吕公', '吕雉', '吕家人'],
  },
  {
    id: 'S8-liubang-marriage',
    location: '沛县吕家宴席与婚礼厅堂',
    time: '吕雉与刘邦成婚前后',
    purpose: '把“父亲为何把女儿嫁给刘邦”拍成一次具体的观察、决定和简陋婚礼。',
    emotionalTurn: '吕公观察刘邦并作出判断，吕雉从迟疑进入无法撤回的婚事。',
    conflict: '吕公看中刘邦的气势，吕雉面对年龄、处境和婚书没有退路。',
    anchorAction: '刘邦走入宴席，吕公打量并招呼他；随后把婚书递给吕雉。',
    exitTransition: '婚礼红烛熄灭，切入婚后土屋中两个孩子的哭声。',
    characters: ['吕公', '吕雉', '刘邦', '宾客'],
  },
  {
    id: 'S9-family-hardship',
    location: '沛县吕家农舍、田地与山道',
    time: '婚后到刘邦逃入芒砀山',
    purpose: '用连续家务、离家和送粮动作展示吕雉如何独自维持家庭。',
    emotionalTurn: '新婚和生育的家庭日常逐渐变成独自劳作、等待和奔波。',
    conflict: '刘邦不断离家，吕雉必须在孩子、田地和被追捕的丈夫之间做选择。',
    anchorAction: '吕雉抱孩子、下田、织布并翻山送包裹；刘邦则押送失败后钻入山林。',
    exitTransition: '山洞口包裹被接走，硬切潮湿牢门，吕雉从农妇变成囚徒。',
    characters: ['吕雉', '刘邦', '孩子', '吕公婆'],
  },
  {
    id: 'S10-chu-hostage',
    location: '秦末牢房与楚军囚营',
    time: '刘邦起兵后、楚汉战争期间',
    purpose: '把吕雉承受的监禁和人质经历落到牢门、栅栏和囚帐的连续动作。',
    emotionalTurn: '短暂的家庭困苦升级为被关押、被押解、长期等待生死。',
    conflict: '吕雉和刘太公失去行动自由，只能在楚营等待刘邦是否来救。',
    anchorAction: '狱卒把吕雉推入牢房；楚军再押她和刘太公穿过营栅并关进囚帐。',
    exitTransition: '栅门拉上后只留下火光和两人的背影，为后续楚汉冲突留出黑场。',
    characters: ['吕雉', '刘太公', '秦军狱卒', '楚军士兵'],
  },
]

const extensionDefinitions = [
  {
    id: 'B11-young-luzhi', sceneId: 'S6-young-luzhi-home', sourceStoryboardIds: [3606],
    sourceText: '吕雉年轻的时候，根本不像后来那个心狠手辣的太后。', function: 'origin',
    actorIds: ['吕雉'], target: '窗边丝线与院门外车队',
    action: '少女吕雉坐在窗前捻丝，听见院外车轮后停下手里的线团，抬头望向门口。',
    beforeState: '吕雉在窗前安静做针线，不知道家中将要搬迁。',
    afterState: '她放下丝线站起身，目光追向院外驶过的车队。',
    result: '少女的日常被搬迁打断，故事从她的家庭处境开始。',
    visualProof: ['吕雉低头捻丝', '她抬头看向院门和车轮'],
    shot: { shotType: '中近景', angle: '侧面平视', blocking: '吕雉在窗前，车队从院门外经过形成前后景', camera: '缓慢推近后跟随她抬头', transition: '车轮声匹配切到沛县城门' },
    assetStrategy: 'existing-still', location: '吕家旧宅窗前', time: '少女时期白天', lighting: '窗边暖侧光，院门外尘土逆光', props: ['丝线', '木窗', '车轮'],
  },
  {
    id: 'B12-family-migration', sceneId: 'S7-pei-family-arrival', sourceStoryboardIds: [3607],
    sourceText: '她是砀郡单父县人，父亲吕公因为躲避仇家，搬到了沛县。', function: 'setup',
    actorIds: ['吕公', '吕雉', '吕家人'], target: '沛县城门与客舍',
    action: '吕公带着家人走入沛县城门，吕雉掀帘查看陌生街道，车队在客舍前停下。',
    beforeState: '吕家车队还在城外赶路，家人挤在装满行李的车厢里。',
    afterState: '车队驶入沛县，在陌生客舍前停住，家人开始卸下行李。',
    result: '吕家正式落脚沛县，吕雉进入与刘邦相遇的生活半径。',
    visualProof: ['车队穿过城门', '吕雉掀帘看街道，车轮在客舍前停下'],
    shot: { shotType: '远景转中景', angle: '低机位侧拍', blocking: '车队由画面左侧进入城门，吕雉在车厢右侧掀帘', camera: '横向跟拍车轮后抬到车厢', transition: '车轮落尘匹配切到酒碗' },
    assetStrategy: 'existing-still', location: '沛县城门', time: '迁居黄昏', lighting: '夕阳侧逆光，尘土显出车队轮廓', props: ['木车', '行李', '城门'],
  },
  {
    id: 'B13-luzhi-meets-liubang', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3608],
    sourceText: '吕公这个人会看相，第一次见到刘邦，就觉得这人将来能成大事。', function: 'inciting-decision',
    actorIds: ['吕公', '刘邦', '吕雉'], target: '宴席门口的刘邦',
    action: '刘邦走入宴席端着酒碗，吕公放下酒杯从头到脚观察他，抬手招呼他坐近。',
    beforeState: '刘邦只是站在宴席门口的陌生亭长，吕公还没有作出判断。',
    afterState: '吕公示意刘邦坐到近前，吕雉在屏风后第一次清楚看见他。',
    result: '吕公把刘邦从普通宾客中单独挑出来，婚事有了具体的推动者。',
    visualProof: ['刘邦端碗走入宴席', '吕公放下酒杯抬手让他坐近'],
    shot: { shotType: '双人中景', angle: '过肩平视', blocking: '吕公在前景落座，刘邦从门口走近，吕雉隔屏观察', camera: '跟随刘邦入席后停在吕公视线轴', transition: '酒碗落桌切到街巷喧闹' },
    assetStrategy: 'existing-still', location: '沛县吕家宴席', time: '迁居后不久的夜晚', lighting: '油灯暖光，门口留一块冷色天光', props: ['酒碗', '席案', '屏风'],
  },
  {
    id: 'B14-liubang-street', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3609],
    sourceText: '当时刘邦是什么人？沛县的一个亭长，年纪不小，四十来岁，游手好闲', function: 'character-contrast',
    actorIds: ['刘邦', '沛县熟人'], target: '沛县街巷与酒肆',
    action: '刘邦穿着旧吏服在沛县街巷晃荡，拍桌喝酒，和熟人拱手调笑后转身离开。',
    beforeState: '亭舍有差事等着处理，刘邦却站在酒肆门口无所事事。',
    afterState: '他把公事撂在一边带着酒意离开，街上的人目送他消失。',
    result: '吕公要嫁女的对象被具体呈现为有职位却不安分的中年男人。',
    visualProof: ['刘邦在酒肆拍桌举碗', '他拱手调笑后转身走出街巷'],
    shot: { shotType: '街巷中景', angle: '手持平视', blocking: '刘邦居中穿过人群，酒肆桌案在前景，熟人从两侧探身', camera: '轻微横移跟拍，末尾留出空街', transition: '刘邦离开画面后接曹氏门口' },
    assetStrategy: 'existing-still', location: '沛县街巷酒肆', time: '白天', lighting: '硬朗日光与酒肆阴影交错', props: ['旧吏服', '酒碗', '木桌'],
  },
  {
    id: 'B15-liubang-no-foundation', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3609],
    sourceText: '还和一个姓曹的女人生了个私生子。用今天的话说，就是个中年油腻男，没车没房没正经工作。', function: 'character-contrast',
    actorIds: ['刘邦', '曹氏', '孩子'], target: '曹氏家门与孩子',
    action: '刘邦在曹氏家门口抱过孩子又转身离开，曹氏独自收拾屋内的衣物和饭碗。',
    beforeState: '孩子在门内等待，刘邦短暂停留在曹氏家门口。',
    afterState: '刘邦转身离开，曹氏和孩子留在屋里，生活仍由她独自承担。',
    result: '刘邦没有稳定家庭和住处，吕雉即将被交给这样的男人。',
    visualProof: ['刘邦在门口短暂抱起孩子', '他转身离开，曹氏带孩子回屋'],
    shot: { shotType: '中近景', angle: '门框内平视', blocking: '曹氏和孩子在门内，刘邦占门外前景，离开时穿过画面', camera: '先固定观察再小幅跟出门外', transition: '衣物落在桌面上切到婚书' },
    assetStrategy: 'existing-still', location: '沛县民居门口', time: '白天', lighting: '门内柔暗、门外偏亮，形成生活落差', props: ['孩子', '衣物', '饭碗'],
  },
  {
    id: 'B16-marriage-decision', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3610],
    sourceText: '但吕公坚持把女儿吕雉嫁给他。吕雉比刘邦小十五岁左右，正是青春年华。', function: 'decision',
    actorIds: ['吕公', '吕雉', '刘邦'], target: '堂前婚事与等候的刘邦',
    action: '吕公把吕雉叫到堂前，指向等候的刘邦，按住她想退后的手，点头定下婚事。',
    beforeState: '吕雉站在堂侧还没有答应，刘邦在门边等待吕公发话。',
    afterState: '吕公按住吕雉的手作出决定，她被留在刘邦面前无法退回。',
    result: '婚事不是吕雉主动提出，而是吕公当面推动并敲定。',
    visualProof: ['吕公把吕雉叫到堂前', '他按住她的手并指向刘邦'],
    shot: { shotType: '三人中景', angle: '正面平视', blocking: '吕公居中，吕雉在左侧后退半步，刘邦在右侧门边', camera: '从吕雉后退的小动作推到吕公按手', transition: '手按住婚书切到红烛' },
    assetStrategy: 'existing-still', location: '吕家堂屋', time: '夜晚婚前', lighting: '红烛暖光压住门口冷光', props: ['婚书', '红烛', '木案'],
  },
  {
    id: 'B17-poor-wedding', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3610],
    sourceText: '她嫁给刘邦的时候，刘邦连个像样的婚礼都办不起，客人礼金还是他赊来的。', function: 'consequence',
    actorIds: ['吕雉', '刘邦', '宾客'], target: '简陋婚礼厅堂的礼金簿',
    action: '简陋厅堂里刘邦向宾客拱手记下赊来的礼金，吕雉在红烛旁低头行礼。',
    beforeState: '厅堂只有借来的酒席和几张木案，宾客还在等着仪式开始。',
    afterState: '礼金被记在欠账簿上，宾客散去，吕雉和刘邦留在冷掉的席面旁。',
    result: '这段婚姻从第一天就带着欠账和寒酸的现实。',
    visualProof: ['刘邦在礼金簿上记账', '吕雉低头行礼，散席后只剩冷掉的酒菜'],
    shot: { shotType: '厅堂中近景', angle: '侧面平视', blocking: '刘邦在前景记账，吕雉在红烛后景行礼，宾客从后方离席', camera: '从礼金簿推到吕雉低头的脸', transition: '红烛火苗压暗接到婚后土屋' },
    assetStrategy: 'existing-still', location: '沛县简陋婚礼厅堂', time: '婚礼夜晚', lighting: '单一红烛和低照度室内光', props: ['礼金簿', '红烛', '酒席'],
  },
  {
    id: 'B18-arranged-marriage', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3611],
    sourceText: '你能想象吕雉当时的心情吗？一个富家小姐，被父亲许配给一个比自己大十几岁的基层公务员，对方还风流成性。', function: 'interior-conflict',
    actorIds: ['吕雉', '吕公', '刘邦'], target: '吕雉手里的婚书',
    action: '吕公把婚书递给吕雉，刘邦在门边整理旧吏服，吕雉抬眼看他又移开视线。',
    beforeState: '婚书还在吕公手中，吕雉只听见父亲安排却没有拿到凭据。',
    afterState: '吕雉接过婚书，短暂看向刘邦后把视线移回纸面。',
    result: '年龄差、身份差和刘邦的风流被放进同一个具体的婚前瞬间。',
    visualProof: ['吕公把婚书递出', '吕雉看刘邦一眼后低头握紧婚书'],
    shot: { shotType: '过肩中近景', angle: '平视', blocking: '吕公手臂从前景递入，吕雉居中，刘邦被门框切在后景', camera: '沿婚书向上摇到吕雉的视线', transition: '婚书折入袖中接下一 beat' },
    assetStrategy: 'existing-still', location: '吕家内堂', time: '婚前夜晚', lighting: '烛光打在婚书和吕雉手上，刘邦处在半暗处', props: ['婚书', '旧吏服', '木门'],
  },
  {
    id: 'B19-no-choice', sceneId: 'S8-liubang-marriage', sourceStoryboardIds: [3611],
    sourceText: '她心里肯定不愿意。但那个时代，女人没有选择权。', function: 'interior-conflict',
    actorIds: ['吕雉', '吕公'], target: '堂屋门槛与婚书',
    action: '吕雉攥紧婚书站在门槛内，父亲转身离开，她最终把婚书收进袖中。',
    beforeState: '吕雉仍站在门槛内，婚书攥在手里，父亲还在等她表态。',
    afterState: '吕公走远，吕雉把婚书收进袖中，独自跨过门槛。',
    result: '她没有改变婚事，只能把不愿意收起来并走向既定生活。',
    visualProof: ['吕雉攥紧婚书看着父亲背影', '她把婚书收入袖中跨过门槛'],
    shot: { shotType: '中景', angle: '门槛侧拍', blocking: '吕雉在门内，吕公背对镜头走向院中，门槛形成明确边界', camera: '从手中婚书平移到跨门动作', transition: '脚步声接入婴儿哭声' },
    assetStrategy: 'existing-still', location: '吕家堂屋门槛', time: '夜晚', lighting: '室内暖光逐渐落到院中冷光', props: ['婚书', '门槛', '袖口'],
  },
  {
    id: 'B20-family-labor', sceneId: 'S9-family-hardship', sourceStoryboardIds: [3612],
    sourceText: '婚后的吕雉，倒也没有抱怨。她给刘邦生了一儿一女，儿子就是后来的汉惠帝刘盈，女儿是鲁元公主。', function: 'family',
    actorIds: ['吕雉', '刘盈', '鲁元公主', '吕公婆'], target: '沛县农舍里的两个孩子',
    action: '吕雉在土屋里抱起襁褓中的儿子，又把女儿交给婆婆，转身去添柴烧饭。',
    beforeState: '两个孩子在土屋里哭闹，家中没有人准备饭食。',
    afterState: '孩子被安顿下来，吕雉转身添柴，屋里重新有了热气和饭香。',
    result: '她把生儿育女变成每天必须完成的具体劳动。',
    visualProof: ['吕雉抱起襁褓中的儿子', '她把女儿交给婆婆后转身添柴'],
    shot: { shotType: '室内中景', angle: '平视', blocking: '吕雉在前景抱孩子，婆婆从侧面接过女儿，灶台在后景', camera: '跟随交接孩子后小幅横移到灶台', transition: '柴火亮起匹配田地日光' },
    assetStrategy: 'existing-still', location: '沛县吕家农舍', time: '婚后白天', lighting: '灶火暖光和门缝日光混合', props: ['襁褓', '柴火', '陶碗'],
  },
  {
    id: 'B21-supports-household', sceneId: 'S9-family-hardship', sourceStoryboardIds: [3612],
    sourceText: '她种地、织布、孝顺公婆，一个人撑起这个家。', function: 'family',
    actorIds: ['吕雉', '吕公婆'], target: '田地、织机与公婆饭桌',
    action: '吕雉在田里弯腰插秧，回屋后坐到织机前，随后站起把水递给公婆。',
    beforeState: '田地、织机和饭桌都等着处理，刘邦不在家中。',
    afterState: '田埂被插满秧苗，布线织起，公婆接过她端来的水。',
    result: '吕雉用一连串重复劳动维持住家人的日常。',
    visualProof: ['吕雉弯腰插秧', '她在织机前起身把水递给公婆'],
    shot: { shotType: '动作蒙太奇中景', angle: '平视与低机位交替', blocking: '田地、织机、饭桌保持同一生活空间轴', camera: '田地横移到织机，再跟随端水起身', transition: '水碗放桌切到刘邦离家背影' },
    assetStrategy: 'existing-still', location: '沛县农舍与田地', time: '婚后数年', lighting: '日光、屋内木色和灶火保持连续', props: ['秧苗', '织机', '水碗'],
  },
  {
    id: 'B22-liubang-away', sceneId: 'S9-family-hardship', sourceStoryboardIds: [3613],
    sourceText: '刘邦呢？整天在外面晃荡，动不动就出门公干，几个月不回家。', function: 'absence',
    actorIds: ['刘邦', '吕雉', '孩子'], target: '村口离家的道路',
    action: '刘邦披着旧斗篷骑马离开村口，吕雉牵着孩子站在门边目送，屋门慢慢合上。',
    beforeState: '刘邦刚回到家门口，吕雉和孩子以为他会留下帮忙。',
    afterState: '他再次骑马离开，吕雉牵孩子回屋，门外只剩马蹄声。',
    result: '家庭的时间被刘邦一次次离家切断，等待变成吕雉的日常。',
    visualProof: ['刘邦披斗篷上马离开', '吕雉牵孩子回屋并合上门'],
    shot: { shotType: '村口远中景', angle: '背面平视', blocking: '刘邦从右向左离开，吕雉和孩子固定在门框内', camera: '跟拍马匹两步后回摇到门内', transition: '马蹄声压住切到押送山道' },
    assetStrategy: 'existing-still', location: '沛县村口', time: '清晨', lighting: '门内暖暗，村口冷日光', props: ['旧斗篷', '木门', '马匹'],
  },
  {
    id: 'B23-liubang-escapes', sceneId: 'S9-family-hardship', sourceStoryboardIds: [3613],
    sourceText: '有一次他押送囚徒去骊山，半路上囚徒跑了，他干脆躲进芒砀山，当起了土匪。', function: 'turning-point',
    actorIds: ['刘邦', '囚徒'], target: '骊山山道与芒砀山林',
    action: '刘邦押着囚徒走在山道上，发现绳索空了后扔下竹简，转身钻入芒砀山林。',
    beforeState: '囚徒被绳索连在一起，刘邦还以亭长身份押送他们赶路。',
    afterState: '绳索散开、囚徒逃走，刘邦丢下公文转身钻进山林躲藏。',
    result: '一次押送失败把刘邦从亭长推向逃亡和聚众生活。',
    visualProof: ['空绳索落在山道上', '刘邦扔下竹简转身钻入山林'],
    shot: { shotType: '山道中远景', angle: '低机位跟拍', blocking: '囚徒沿山道向前跑散，刘邦在后景停下再转向林口', camera: '先追绳索再急转跟进山林', transition: '林叶遮镜切到吕雉背包翻山' },
    assetStrategy: 'existing-still', location: '骊山至芒砀山道', time: '白天转阴', lighting: '山道冷硬天光，林中压暗', props: ['绳索', '竹简', '斗篷'],
  },
  {
    id: 'B24-luzhi-brings-provisions', sceneId: 'S9-family-hardship', sourceStoryboardIds: [3614],
    sourceText: '吕雉不仅要独自抚养孩子，还要隔三差五翻山越岭，给刘邦送吃送穿。', function: 'sacrifice',
    actorIds: ['吕雉', '刘邦', '孩子'], target: '芒砀山洞口的包裹',
    action: '吕雉背着布包牵着孩子爬过山路，把包裹递给藏在山洞口的刘邦。',
    beforeState: '吕雉和孩子在山脚，布包里装着食物和衣物，刘邦躲在山洞里等待。',
    afterState: '刘邦接过包裹，吕雉仍站在洞口，孩子靠在她身边没有进洞。',
    result: '她把家里的有限物资送给逃亡的丈夫，自己继续承担回程。',
    visualProof: ['吕雉背包牵孩子爬山', '她把包裹递进洞口由刘邦接住'],
    shot: { shotType: '山道中景', angle: '侧逆光平视', blocking: '吕雉从坡下进入，刘邦在洞口阴影中伸手，孩子贴在她身侧', camera: '沿山坡上移后停在交接包裹的手上', transition: '包裹接住的动作切到空屋' },
    assetStrategy: 'existing-still', location: '芒砀山洞口', time: '阴天', lighting: '山外冷蓝、洞内暖暗形成前后景', props: ['布包', '食物', '旧衣'],
  },
  {
    id: 'B25-abandoned-wife', sceneId: 'S9-family-hardship', sourceStoryboardIds: [3614],
    sourceText: '那时候的她，就是一个普通农妇，一个被丈夫抛下的妻子。', function: 'emotional-consequence',
    actorIds: ['吕雉', '孩子'], target: '空屋、旧斗篷与孩子的饭碗',
    action: '吕雉独自挑水回到空屋，把刘邦留下的旧斗篷挂上墙，又低头给孩子分粥。',
    beforeState: '刘邦已经离开，屋里只有空床、旧斗篷和等饭的孩子。',
    afterState: '斗篷被挂起，孩子捧到饭碗，吕雉坐在门边继续缝补。',
    result: '她被留下的生活没有戏剧化宣言，只有每天把家重新收拾起来。',
    visualProof: ['吕雉挑水进空屋并挂起旧斗篷', '她低头给孩子分粥后坐下缝补'],
    shot: { shotType: '室内中近景', angle: '门框平视', blocking: '吕雉从门外入画，旧斗篷在墙上，孩子位于低处前景', camera: '跟随水桶到墙面再下摇到饭碗', transition: '缝补针尖闪光切到牢门铁扣' },
    assetStrategy: 'existing-still', location: '沛县吕家空屋', time: '傍晚', lighting: '门外冷光压进室内木色暗部', props: ['水桶', '旧斗篷', '饭碗', '针线'],
  },
  {
    id: 'B26-luzhi-imprisoned', sceneId: 'S10-chu-hostage', sourceStoryboardIds: [3615],
    sourceText: '后来刘邦起兵反秦，吕雉的日子更苦了。她被抓进过监狱，受过狱卒欺辱。', function: 'ordeal',
    actorIds: ['吕雉', '狱卒'], target: '潮湿牢房木门与门闩',
    action: '狱卒把吕雉推入潮湿牢房并落下门闩，她扶着木栏站起，护住怀中的衣包。',
    beforeState: '吕雉还在牢门外被狱卒押着，手里护着家人的衣物。',
    afterState: '木门和门闩把她关在牢内，她扶着木栏站稳，衣包仍抱在胸前。',
    result: '战争把家庭困苦升级为真实的监禁和身体上的失去自由。',
    visualProof: ['狱卒推吕雉入牢并压下门闩', '她扶木栏站起护住衣包'],
    shot: { shotType: '牢房中近景', angle: '低机位平视', blocking: '狱卒在门外形成黑色前景，吕雉被推入后贴近木栏', camera: '从门闩落下快速推到她扶栏的手', transition: '门闩声延续到楚营栅门' },
    assetStrategy: 'existing-still', location: '秦末牢房', time: '起兵后阴天', lighting: '窄窗冷光切过潮湿墙面，人物半明半暗', props: ['木栏', '门闩', '衣包'],
  },
  {
    id: 'B27-chu-hostage', sceneId: 'S10-chu-hostage', sourceStoryboardIds: [3616, 3617],
    sourceText: '楚汉战争的时候，她和刘邦的父亲一起被项羽俘虏，在楚营里待了二十八个月。', function: 'captivity',
    sourceSpansExtra: ['二十八个月，接近两年半。'],
    actorIds: ['吕雉', '刘太公', '楚军士兵'], target: '楚军营栅与囚帐',
    action: '楚军押着吕雉和刘太公穿过营栅，守卫把他们带入囚帐并拉上栅门。',
    beforeState: '吕雉和刘太公被押在楚营外，还能看见营外道路和火把。',
    afterState: '两人被带进囚帐，栅门拉上，火光只照到他们的背影。',
    result: '二十八个月的囚禁被落到一扇接连关闭的营门上。',
    visualProof: ['楚军押着吕雉和刘太公穿过营栅', '囚帐门帘和栅门同时合上'],
    shot: { shotType: '囚营远中景', angle: '背面低机位', blocking: '楚军在两侧押解，吕雉和刘太公并行进入囚帐，栅门在后景', camera: '跟随背影穿过营道后停在栅门外', transition: '栅门合拢后保留火光黑场' },
    assetStrategy: 'existing-still', location: '楚军囚营', time: '楚汉战争夜晚', lighting: '冷蓝夜色与火把暖光对照', props: ['营栅', '火把', '囚帐'],
  },
]

let cursor = 0
const extensionBeats = extensionDefinitions.map((beat, index) => {
  const sourceSpans = [span(beat.sourceText, cursor)]
  cursor += beat.sourceText.length + 1
  if (beat.sourceSpansExtra) {
    for (const text of beat.sourceSpansExtra) {
      sourceSpans.push(span(text, cursor))
      cursor += text.length + 1
    }
  }
  const normalized = { ...beat, sourceSpans }
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
    causalReason: index === 0
      ? '承接前 60 秒的权力揭示，先回到吕雉成为太后之前的家庭起点。'
      : `承接上一 beat 的结果：${extensionDefinitions[index - 1].result}`,
    nextBeatId: extensionDefinitions[index + 1]?.id || null,
    shot: { ...normalized.shot, reference: visualReference },
    assetStrategy: normalized.assetStrategy,
    sourceStoryboardIds: normalized.sourceStoryboardIds,
    location: normalized.location,
    time: normalized.time,
    lighting: normalized.lighting,
    props: normalized.props,
  }
})

const plan = {
  ...source,
  pilot: { ...(source.pilot || {}), startMs: 0, endMs: 180000, stopBeforeAssetGeneration: true },
  scenes: [...source.scenes, ...extensionScenes],
  beats: [...source.beats, ...extensionBeats],
  reviewNotes: [
    ...(source.reviewNotes || []),
    '180 秒扩展回归保留前 60 秒批准时序；后续 120 秒覆盖吕雉从少女、婚姻、家庭劳作到被俘的连续事件。',
    '扩展资产只使用独立 2x1 静态 sheet；旧源图若为多栏图，必须先裁单栏再输出，不得嵌套多宫格。',
  ],
}

fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, `${JSON.stringify(plan, null, 2)}\n`)
console.log(JSON.stringify({ output: outputFile, scenes: plan.scenes.length, beats: plan.beats.length, durationMs: plan.pilot.endMs }, null, 2))
