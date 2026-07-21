/**
 * 单图叙事流水线（生产版）
 * 每个镜头：LLM 选择一个决定性画面（构图四要素 + 运镜 + 过场 + 可选文字层）
 * → 生成一张完整 16:9 图片 → 写回 storyboards.gridCells / gridSheetImage
 * 规格（v8 冻结）：每镜一张横屏图 / 图片零文字 / 运镜 push·pull·tiltDown·tiltUp·hold /
 * 过场 cut·dissolve·fade（reveal 仅全片第一格）/ 时代自洽 / 三分法·分层·引导线·方向光
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { aiFetch } from './ai-client.js'
import {
  buildHistoryLookInstruction,
  buildHistoryVisualStyleDirective,
  resolveHistoryVisualStyle,
} from './history-visual-style.js'
import { sanitizeCharacterVisualIdentity } from './character-visual-identity.js'
import { createTask } from './tasks/store.js'

export type GridMove = 'push' | 'pull' | 'tiltDown' | 'tiltUp' | 'hold'
export type GridEnter = 'cut' | 'dissolve' | 'fade' | 'reveal'
export type GridShotSize = 'establishing_wide' | 'wide' | 'full' | 'medium' | 'close' | 'face_closeup' | 'extreme_detail'
export type GridCameraAngle = 'eye_level' | 'low_angle' | 'high_angle' | 'over_shoulder'
export type GridFocusDepth = 'deep' | 'medium' | 'shallow'
export type GridScreenDirection = 'left_to_right' | 'right_to_left' | 'static'

export interface GridBeatGraphicBignum { type: 'bignum'; value: number; prefix?: string; suffix?: string; label: string }
export interface GridBeatGraphicTrend { type: 'trend'; title: string; unit?: string; points: Array<{ label: string; value: number }> }
export interface GridBeatGraphicCard { type: 'card'; title: string; lines: string[] }
export interface GridBeatGraphicIdentityReveal {
  type: 'identity_reveal'
  placement?: 'left' | 'right'
  aliasLabel?: string
  alias?: string
  verdict?: string
  truthLabel?: string
  truth?: string
}
export type GridBeatGraphic = GridBeatGraphicBignum | GridBeatGraphicTrend | GridBeatGraphicCard | GridBeatGraphicIdentityReveal

export interface GridBeat {
  description: string
  move: GridMove
  enter: GridEnter
  enterFrames?: number
  graphic?: GridBeatGraphic
  shotSize?: GridShotSize
  cameraAngle?: GridCameraAngle
  focusDepth?: GridFocusDepth
  screenDirection?: GridScreenDirection
}

export interface GridLook {
  palette: string
  lighting: string
  mood: string
}

export interface GridDecomp {
  theme: string
  displayTitle?: string
  look?: GridLook
  beats: [GridBeat]
}

export interface GridCell extends GridBeat {
  src?: string
}

const MOVES: readonly GridMove[] = ['push', 'pull', 'tiltDown', 'tiltUp', 'hold']
const ENTERS: readonly GridEnter[] = ['cut', 'dissolve', 'fade']
const SHOT_SIZES: readonly GridShotSize[] = ['establishing_wide', 'wide', 'full', 'medium', 'close', 'face_closeup', 'extreme_detail']
const CAMERA_ANGLES: readonly GridCameraAngle[] = ['eye_level', 'low_angle', 'high_angle', 'over_shoulder']
const FOCUS_DEPTHS: readonly GridFocusDepth[] = ['deep', 'medium', 'shallow']
const SCREEN_DIRECTIONS: readonly GridScreenDirection[] = ['left_to_right', 'right_to_left', 'static']

export const MAX_SINGLE_IMAGE_SHOT_SECONDS = 8

export interface RealityContractInput {
  narration?: string | null
  location?: string | null
  description?: string | null
}

export interface NarrationEvidenceContractInput {
  narration?: string | null
  description?: string | null
  graphic?: GridBeatGraphic | null
}

const VISIBLE_REMAINS_PATTERN = /(?:尸体|遗体|遗容|棺内|棺中|敞开[^。；，,]{0,8}(?:棺材|棺木|棺盖)|打开[^。；，,]{0,8}(?:棺材|棺木|棺盖)|半开[^。；，,]{0,8}(?:棺材|棺木|棺盖)|open casket|open coffin|corpse|dead body)/iu
const REMAINS_NARRATION_AUTHORITY_PATTERN = /(?:瞻仰遗容|遗体告别|开棺|棺内|棺中|尸体|遗体|遗容|入殓|停尸)/u
const VIEWING_CONTEXT_PATTERN = /(?:瞻仰|告别仪式|守灵|灵堂|殡仪|教堂|入殓|停尸房)/u
const BURIAL_LOCATION_PATTERN = /(?:墓地|墓穴|坟场|下葬|安葬)/u
const LIVING_STATE_PATTERN = /(?:活着|生前|在世时|在世期间)/u
const POST_DEATH_STATE_PATTERN = /(?:死了|死后|身后|去世后|下葬|安葬|埋葬)/u
const GENERIC_PROXY_BROLL_PATTERN = /(?:记者[^。；，,]{0,16}(?:询问|采访)|店员[^。；，,]{0,16}(?:摇头|挂钥匙)|(?:人物|男人|女人|老人)[^。；，,]{0,12}(?:写字|书写|拿着?(?:本子|书|钱包)|看文件)|挂(?:回)?钥匙|翻看文件)/u

const NARRATION_EVIDENCE_RULES: Array<{
  narration: RegExp
  excludeNarration?: RegExp
  evidence: RegExp
  issue: string
}> = [
  {
    narration: /(?:东躲西藏|逃亡|逃跑|躲藏|藏匿|四处躲避|避风头|连夜消失)/u,
    evidence: /(?:逃|躲|藏|离开|驶离|后门|翻窗|回头|皮箱|空房|空屋|湿鞋印|脚印|去向)/u,
    issue: '逃藏旁白缺少逃离、躲避或刚刚离开的直接可见证据',
  },
  {
    narration: /(?:下葬|安葬|埋葬|入土)/u,
    evidence: /(?:棺|墓|墓穴|坟|降棺|葬礼|抬棺|入土)/u,
    issue: '下葬旁白缺少棺木、墓穴或入土动作的直接可见证据',
  },
  {
    narration: /(?:不太好找|找不到|没找到|难以找到|难找|扑空|下落不明|去向不明)/u,
    excludeNarration: /(?:找不到|没找到|难以找到|难找)[^。！？]{0,16}(?:方式|办法|方法|途径)/u,
    evidence: /(?:空房|空屋|空无一人|衣柜[^。；，,]{0,10}空|脚印|后门|门[^。；，,]{0,10}(?:晃动|敞开)|热气|余温|遗留|扑空|去向|离开|消失|躲藏|藏匿)/u,
    issue: '追查落空旁白缺少空房、离开痕迹或扑空结果的直接可见证据',
  },
]

const IDENTITY_CONTRADICTION_PATTERN = /(?:假名|化名|冒名|不叫这个名字|身份不符|真名)/u
const IDENTITY_EVIDENCE_PATTERN = /(?:档案|讣告|记录|照片|墓碑|棺|墓穴|材料|证件|身份|两份|并置|对齐)/u

export function findRealityContractIssues(input: RealityContractInput): string[] {
  const narration = String(input.narration || '')
  const location = String(input.location || '')
  const description = String(input.description || '')
  if (!VISIBLE_REMAINS_PATTERN.test(description)) return []

  const issues: string[] = []
  if (!REMAINS_NARRATION_AUTHORITY_PATTERN.test(narration)) {
    issues.push('当前旁白没有建立遗体展示或开棺行为')
  }
  if (BURIAL_LOCATION_PATTERN.test(location) && !VIEWING_CONTEXT_PATTERN.test(`${narration} ${location}`)) {
    issues.push('墓地下葬场景未建立瞻仰遗容环节，棺盖应保持关闭')
  }
  return issues
}

/**
 * Conservative pre-generation gate for narration classes that repeatedly
 * collapse into generic investigation B-roll. It only covers high-confidence
 * event families; the VLM remains the general semantic reviewer.
 */
export function findNarrationEvidenceContractIssues(input: NarrationEvidenceContractInput): string[] {
  const narration = String(input.narration || '')
  const description = String(input.description || '')
  const issues = NARRATION_EVIDENCE_RULES
    .filter((rule) => rule.narration.test(narration)
      && !rule.excludeNarration?.test(narration)
      && !rule.evidence.test(description))
    .map((rule) => rule.issue)

  if (IDENTITY_CONTRADICTION_PATTERN.test(narration)) {
    if (!IDENTITY_EVIDENCE_PATTERN.test(description)) {
      issues.push('身份矛盾旁白缺少档案、讣告、墓葬或并置材料等可信证据现场')
    }
    if (input.graphic?.type !== 'identity_reveal') {
      issues.push('身份矛盾旁白需要 identity_reveal 信息层承担准确姓名或身份结论')
    }
  }

  if (issues.length && GENERIC_PROXY_BROLL_PATTERN.test(description)) {
    issues.push('画面使用了询问、写字、拿本子或挂钥匙等泛化 B-roll 代替旁白事件')
  }
  return issues
}

export interface GridSequenceContext {
  stage: 'setup' | 'development' | 'turn' | 'landing'
  index: number
  total: number
  previous?: {
    narration: string
    description: string
    shotSize?: GridShotSize
  }
  nextNarration?: string
  sameSceneAsPrevious: boolean
}

export function findSingleImageShotContractIssues(
  storyboards: Array<{ id: number; storyboardNumber?: number | null; duration?: number | null; narration?: string | null }>,
  maxDurationSeconds = MAX_SINGLE_IMAGE_SHOT_SECONDS,
): Array<{ storyboardId: number; storyboardNumber: number; duration: number }> {
  return storyboards
    .map((sb) => ({
      storyboardId: Number(sb.id),
      storyboardNumber: Number(sb.storyboardNumber || 0),
      duration: Number(sb.duration || 0),
    }))
    .filter((sb) => sb.duration > maxDurationSeconds)
}

export function findSingleImageSemanticContractIssues(
  storyboards: Array<{ id: number; storyboardNumber?: number | null; narration?: string | null }>,
): Array<{ storyboardId: number; storyboardNumber: number; reason: string }> {
  return storyboards.flatMap((sb) => {
    const narration = String(sb.narration || '')
    if (!LIVING_STATE_PATTERN.test(narration) || !POST_DEATH_STATE_PATTERN.test(narration)) return []
    return [{
      storyboardId: Number(sb.id),
      storyboardNumber: Number(sb.storyboardNumber || 0),
      reason: '旁白同时包含生前与死后两个不可共存的视觉时态',
    }]
  })
}

function assertSingleImageShotContract(storyboards: any[]) {
  const durationIssues = findSingleImageShotContractIssues(storyboards)
  if (durationIssues.length) {
    const detail = durationIssues.map((issue) => `sb${issue.storyboardNumber}=${issue.duration}s`).join(', ')
    throw new Error(`单图分镜时长必须 <= ${MAX_SINGLE_IMAGE_SHOT_SECONDS}s；请先按旁白语义和真实 TTS 时间拆镜：${detail}`)
  }
  const semanticIssues = findSingleImageSemanticContractIssues(storyboards)
  if (semanticIssues.length) {
    const detail = semanticIssues.map((issue) => `sb${issue.storyboardNumber}：${issue.reason}`).join('；')
    throw new Error(`单图分镜只能承担一个可见事件；请先按互斥时态拆镜：${detail}`)
  }
}

export function buildGridDecompositionSystemPrompt(style?: string | null): string {
  const styleInstruction = buildHistoryLookInstruction(style)
  return `你是历史纪录片的视觉导演。为一个分镜的旁白选择一张决定性16:9横屏画面，并给出该画面的运镜与过场方式。只输出严格 JSON，不要输出任何其他内容。

JSON 结构：
{
  "theme": "本镜头主题与主色调倾向（中文，25字内）",
  "displayTitle": "用于视频左上角的本镜短标题（中文，4-12字，必须完整成句，不得从旁白机械截断）",
  "look": {
    "palette": "美术统一配色：主色不超过3种+1个点缀色+明暗基调（如：墨绿+旧象牙+封蜡红点缀，中低调）",
    "lighting": "光位、光色、质感、时间感（如：左上低角度冷光，薄雾漫射，黄昏前）",
    "mood": "氛围词（如：肃杀、潮湿、压抑中有暖意）"
  },
  "beats": [
    {
      "description": "完整横屏画面描述（中文，90字内）：一个可见动作 + 主体及位置 + 前/中/后景分层 + 光影方向 + 色调（与 look 一致）",
      "shotSize": "establishing_wide|wide|full|medium|close|face_closeup|extreme_detail 之一",
      "cameraAngle": "eye_level|low_angle|high_angle|over_shoulder 之一",
      "focusDepth": "deep|medium|shallow 之一",
      "screenDirection": "left_to_right|right_to_left|static 之一",
      "move": "push|pull|tiltDown|tiltUp|hold 之一",
      "enter": "cut|dissolve|fade 之一",
      "enterFrames": 可选，数字（dissolve 取 15-24，fade 取 10-14）,
      "graphic": 可选，信息图形（见规则6，没有就省略此字段）
    }
  ]
}

硬性规则：
1. beats 恰好 1 个。本镜只表现“本镜准确旁白”里的一个语义事件、一个主要动作和一个视觉锚点；不得延续上一镜已经说完的动作，也不得提前表现下一镜内容。若当前旁白已从“妻子主持葬礼”切到“真名揭示”，画面必须同步切走，禁止继续画妻子。若旁白仍同时包含生前/死后、出发/抵达等单帧不能共存的时态或地点，说明上游尚未拆镜；禁止用记者询问、店员摇头、人物写字、拿本子或摆放钥匙等泛化调查 B-roll 代替核心事件。
1a. 先选择旁白证据路线，优先级固定为：正在发生的直接事件 > 已发生事件留下的后果痕迹 > 可信证据现场与受控后期信息层。抽象评价不得退化成“相关年代的人在做泛化动作”。例如“生前不太好找”应拍刚被清空的房间、仍晃动的后门、热杯或离开脚印，而不是拍记者询问店员。
1b. 每镜必须有一个来自当前史实的注意力锚点：危险、矛盾、发现、不可逆结果、规模、强烈人物选择或异常后果至少一项。旁白本身的反转可以由画面与 graphic 共同显现；不得虚构追逐、冲突或奇观来补刺激。
2. 画面里绝对不要出现任何文字、数字、字幕、印章（信息性内容放进 graphic 字段，由后期叠加层承担）。近景墓碑、书信、招牌、报纸这类天然带文字的物件要特别处理：要么远景/侧影带过，要么明确"碑面刻字隐于阴影、模糊不可辨"；禁止"刻字占满画面""字迹清晰"这类必然翻车 description。
3. 时代自洽：故事发生年代的道具、服饰、建筑、器物必须正确，禁止现代物品、现代字体。
4. move 规则：push=聚焦/逼近/情绪收紧；pull=揭示规模/释然；tiltDown=从天空/高处落到主体；tiltUp=从地面/细节升向主体；hold=信息密度高的画面近乎静止。
5. enter 规则（剪辑语法）：cut=同场景切换（默认）；dissolve=时间流逝/回忆/地点跳转；fade=章节/话题转换。
6. graphic 字段（信息图形，可选）：仅当旁白含有值得可视化的数字、趋势、结论或身份矛盾时才给——大约三分之一格可以有，没有就省略，不是每格都要。四种类型：
   - bignum（单个震撼数字）：{"type":"bignum","value":8000,"prefix":"$","suffix":"美元","label":"普利策悬赏寻人"}；label ≤10 字。
   - trend（2-5 个点的趋势/对比）：{"type":"trend","title":"油价一年之内","unit":"美元/桶","points":[{"label":"低点","value":0.1},{"label":"高点","value":14}]}；title ≤10 字，point label ≤6 字。
   - card（一两行结论）：{"type":"card","title":"复式记账","lines":["一边记生意","一边记上帝"]}；title ≤8 字，每行 ≤12 字、最多 2 行。
   - identity_reveal（假名、身份或档案矛盾）：{"type":"identity_reveal","placement":"right","aliasLabel":"讣告姓名","alias":"William Livingston","verdict":"身份不符","truthLabel":"真实姓名","truth":"William Rockefeller"}。placement 选择画面有负空间且不遮挡人物的一侧。图片只提供无可辨文字的档案、照片或证据现场；姓名由 Remotion 精确绘制。若当前旁白尚未说出真名，只给 alias + verdict，把 truth 留给下一镜。
   禁止：把旁白已经说过的人名/年份/地点直接当 graphic（那是冗余）；数字必须来自旁白，不得编造。
7. 使用完整16:9横屏构图，画面必须是一个单一连续镜头。禁止拼贴、分屏、宫格、画中画、分隔线或同一人物重复出现。
8. look 必填：它是本镜头的美术设定。配色要具体到色名和面积关系，光要写清来源、方向、覆盖区与禁光区；description 必须与 look 保持一致。不得用导演姓名、"电影感"、"高级感"代替可见机制，也不得擅自把每个镜头都变成同一种固定双色或同一种明暗对照。
9. 当前系列风格档案：${styleInstruction}
10. 你在设计连续镜头序列，不是互不相干的海报。镜头节奏遵循“铺垫 → 发展 → 转折 → 落点”；相邻镜头必须有景别、角度或对焦变化，同时保持视线衔接、动作衔接、人物左右关系、屏幕运动方向、镜头轴线、空间关系、光线和色彩连续。
11. 同场景连续性硬规则：人物面孔、年龄、发型、服装、已有道具、环境、时间、天气、光线方向和调色保持一致。只能改变景别、角度、机位、运镜、动作、表情、走位、前景遮挡和对焦。不得新增当前旁白、角色表或参考图中没有的人物、动物、车辆、武器、建筑或道具。
12. 景深服从景别：大全景/远景用 deep，中景用 medium，近景/特写用 shallow；不得每镜都浅景深，也不得连续重复同一景别。连续段落应按内容覆盖环境建立、人物关系、中景动作、人物近景/面部、极致细节、一次高低机位力量镜头和结尾落点，但不能为了凑类型违背旁白。
13. 画面必须像真实电影帧，不要海报、拼贴、概念设计稿或游戏截图。冲突只通过当前已有主体的视线、阴影、反射、遮挡、画外空间、风和细微环境变化表达。
14. 叙事现实硬规则：画面中的行为必须是现实生活中可能发生、且符合当前地点、仪式阶段、人物身份和社会程序的行为。旁白没有建立的开棺、冲突、追逐、哭喊、攻击或仪式动作，不得为了戏剧性自行补充。
15. 抽象信息（身份、关系、评价、秘密、因果）不能靠编造人物表演来证明。若史实本来通过讣告、户籍、档案、账本或照片被发现，可以使用可信的证据插入镜头：手把两份材料对齐、笔尖停住、照片与档案并置等现实可拍动作；纸面文字保持空白、背向或不可辨，准确姓名与结论放入 graphic。不得虚构追逐、冲突或当事人反应。
16. 摄影机位置必须真实可达，不得进入棺内、人体、墙体或其他现实摄影机无法占据的位置。墓地下葬场景默认棺盖关闭；只有旁白明确建立瞻仰遗容、遗体告别或开棺行为时，才允许看见遗体。`
}

interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  provider: string
}

export interface GridPipelineOptions {
  force?: boolean
  onlyStoryboardIds?: number[]
  useReferenceImages?: boolean
}

type ProgressFn = (current: number, total: number, message: string) => void

export function getActiveTextConfig(): LlmConfig {
  const [row] = db
    .select()
    .from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.serviceType, 'text'), eq(schema.aiServiceConfigs.isActive, true)))
    .all()
  if (!row) throw new Error('No active text AI config')
  const model = (() => {
    try {
      const parsed = JSON.parse(row.model || '""')
      return Array.isArray(parsed) ? parsed[0] : String(row.model)
    } catch {
      return String(row.model)
    }
  })()
  return {
    baseUrl: String(row.baseUrl).replace(/\/+$/, ''),
    apiKey: String(row.apiKey),
    model,
    provider: String(row.provider),
  }
}

function getActiveImageConfigId(): number {
  const [row] = db
    .select()
    .from(schema.aiServiceConfigs)
    .where(and(eq(schema.aiServiceConfigs.serviceType, 'image'), eq(schema.aiServiceConfigs.isActive, true)))
    .all()
  if (!row) throw new Error('No active image AI config')
  return Number(row.id)
}

export function buildGridDecompositionUserPrompt(
  sb: any,
  chars: Array<{ name: string | null; appearance: string | null }>,
  sequence?: GridSequenceContext,
): string {
  const narration = String(sb.narration || sb.description || '').trim()
  const charLine = chars.length
    ? `\n出场角色（角色资料只用于锁定恒定身份；动作、姿态、位置和表情只能由当前旁白决定）：${chars.map((c) => `${c.name}（${sanitizeCharacterVisualIdentity(c.appearance) || '恒定外观未设定'}）`).join('、')}`
    : ''
  const stageLabels: Record<GridSequenceContext['stage'], string> = {
    setup: '铺垫/建立环境与人物关系',
    development: '发展/推进动作与情绪',
    turn: '转折/信息或情绪变化',
    landing: '落点/形成有力量的结束画面',
  }
  const sequenceBlock = sequence
    ? `\n连续段落：第 ${sequence.index}/${sequence.total} 镜；阶段：${stageLabels[sequence.stage]}。
${sequence.previous
  ? `上一镜旁白：${sequence.previous.narration}\n上一镜已完成画面：${sequence.previous.description}${sequence.previous.shotSize ? `；景别=${sequence.previous.shotSize}` : ''}\n禁止把上一镜动作带入本镜；例如上一镜是“妻子主持葬礼”，本镜旁白改变后不得继续画妻子主持葬礼。`
  : '本镜是该连续段落的建立镜头。'}
${sequence.nextNarration ? `下一镜旁白（只用于设计衔接，不得提前表现）：${sequence.nextNarration}` : '本镜是该连续段落的落点。'}
同场景连续：${sequence.sameSceneAsPrevious ? '是，锁定人物、服装、环境、天气、光向、轴线、屏幕方向与调色。' : '否，可重新建立空间，但仍保持系列摄影档案。'}`
    : ''
  return `本镜准确旁白（唯一语义依据）：${narration}
镜头时长：${Number(sb.duration || 0)} 秒
场景：${sb.location || '未设定'}；时间：${sb.time || '未设定'}
旧标题与旧画面构想仅供核对，若与本镜准确旁白冲突必须完全忽略：标题=${sb.title || ''}；旧构想=${(sb.action || '').slice(0, 120)}${charLine}${sequenceBlock}
请输出拆帧 JSON。`
}

function sanitizeGraphic(raw: any): GridBeatGraphic | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  if (raw.type === 'bignum' && Number.isFinite(Number(raw.value)) && typeof raw.label === 'string' && raw.label.trim()) {
    return {
      type: 'bignum',
      value: Number(raw.value),
      prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
      suffix: typeof raw.suffix === 'string' ? raw.suffix : '',
      label: raw.label.trim(),
    }
  }
  if (raw.type === 'trend' && typeof raw.title === 'string' && raw.title.trim() && Array.isArray(raw.points)) {
    const points = raw.points
      .filter((p: any) => p && typeof p.label === 'string' && Number.isFinite(Number(p.value)))
      .slice(0, 5)
      .map((p: any) => ({ label: String(p.label), value: Number(p.value) }))
    if (points.length >= 2) {
      return { type: 'trend', title: raw.title.trim(), unit: typeof raw.unit === 'string' ? raw.unit : '', points }
    }
  }
  if (raw.type === 'card' && typeof raw.title === 'string' && raw.title.trim()) {
    const lines = Array.isArray(raw.lines) ? raw.lines.filter((l: any) => typeof l === 'string' && l.trim()).slice(0, 2) : []
    return { type: 'card', title: raw.title.trim(), lines }
  }
  if (raw.type === 'identity_reveal') {
    const alias = typeof raw.alias === 'string' ? raw.alias.trim().slice(0, 64) : ''
    const truth = typeof raw.truth === 'string' ? raw.truth.trim().slice(0, 64) : ''
    if (!alias && !truth) return undefined
    return {
      type: 'identity_reveal',
      ...(raw.placement === 'left' || raw.placement === 'right' ? { placement: raw.placement } : {}),
      ...(typeof raw.aliasLabel === 'string' && raw.aliasLabel.trim() ? { aliasLabel: raw.aliasLabel.trim().slice(0, 16) } : {}),
      ...(alias ? { alias } : {}),
      ...(typeof raw.verdict === 'string' && raw.verdict.trim() ? { verdict: raw.verdict.trim().slice(0, 16) } : {}),
      ...(typeof raw.truthLabel === 'string' && raw.truthLabel.trim() ? { truthLabel: raw.truthLabel.trim().slice(0, 16) } : {}),
      ...(truth ? { truth } : {}),
    }
  }
  return undefined
}

function validateDecomp(raw: any): GridDecomp | null {
  if (!raw || typeof raw.theme !== 'string' || !Array.isArray(raw.beats) || raw.beats.length !== 1) return null
  if (raw.displayTitle != null) {
    raw.displayTitle = typeof raw.displayTitle === 'string' && raw.displayTitle.trim()
      ? raw.displayTitle.trim().slice(0, 12)
      : undefined
  }
  // look 是美学设定：缺失或残缺就剥掉（出图提示词退回通用画质底线），不废整次拆帧
  if (raw.look != null) {
    const l = raw.look
    raw.look = l && typeof l === 'object' && typeof l.palette === 'string' && typeof l.lighting === 'string' && typeof l.mood === 'string'
      ? { palette: l.palette, lighting: l.lighting, mood: l.mood }
      : undefined
  }
  for (const b of raw.beats) {
    if (typeof b.description !== 'string' || !b.description.trim()) return null
    if (!MOVES.includes(b.move)) return null
    if (!ENTERS.includes(b.enter)) return null
    if (b.shotSize != null && !SHOT_SIZES.includes(b.shotSize)) return null
    if (b.cameraAngle != null && !CAMERA_ANGLES.includes(b.cameraAngle)) return null
    if (b.focusDepth != null && !FOCUS_DEPTHS.includes(b.focusDepth)) return null
    if (b.screenDirection != null && !SCREEN_DIRECTIONS.includes(b.screenDirection)) return null
    // graphic 是可选增强：非法就剥掉，不因此废掉整次拆帧
    if (b.graphic != null) b.graphic = sanitizeGraphic(b.graphic)
  }
  return raw as GridDecomp
}

export async function decomposeShotForGrid(
  sb: any,
  chars: Array<{ name: string | null; appearance: string | null }>,
  style?: string | null,
  sequence?: GridSequenceContext,
): Promise<GridDecomp> {
  const llm = getActiveTextConfig()
  const body = {
    model: llm.model,
    messages: [
      { role: 'system', content: buildGridDecompositionSystemPrompt(style) },
      { role: 'user', content: buildGridDecompositionUserPrompt(sb, chars, sequence) },
    ],
    temperature: 0.7,
    response_format: { type: 'json_object' },
  }
  let retryFeedback = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const attemptBody = {
      ...body,
      messages: retryFeedback
        ? [...body.messages, { role: 'user', content: retryFeedback }]
        : body.messages,
      ...(attempt === 1 ? {} : { response_format: undefined }),
    }
    const res = await aiFetch(llm.provider, `${llm.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llm.apiKey}` },
      body: JSON.stringify(attemptBody),
    })
    if (!res.ok) throw new Error(`llm HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    const content = String(json.choices?.[0]?.message?.content || '')
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
    try {
      const parsed = validateDecomp(JSON.parse(cleaned))
      if (parsed) {
        const realityIssues = findRealityContractIssues({
          narration: sb.narration || sb.description,
          location: sb.location,
          description: parsed.beats[0].description,
        })
        const evidenceIssues = findNarrationEvidenceContractIssues({
          narration: sb.narration || sb.description,
          description: parsed.beats[0].description,
          graphic: parsed.beats[0].graphic,
        })
        const issues = [...realityIssues, ...evidenceIssues]
        if (!issues.length) return parsed
        retryFeedback = `上一版分镜未通过纪实可信度或旁白可见证据门禁，必须完全重写：${issues.join('；')}。不要解释，只重新输出符合原 JSON 结构的分镜。`
      }
    } catch {
      /* retry once */
    }
  }
  throw new Error(`storyboard ${sb.id} 拆帧两次均未通过格式或现实可信度检查${retryFeedback ? `：${retryFeedback}` : ''}`)
}

export function buildShotImagePrompt(
  theme: string,
  beat: GridBeat,
  look?: GridLook,
  style?: string | null,
): string {
  const styleDirective = buildHistoryVisualStyleDirective(style)
  const lookBlock = look
    ? `本镜头美术设定（必须严格遵守，并服从系列风格档案）：配色 ${look.palette}；光影 ${look.lighting}；氛围 ${look.mood}。`
    : ''
  const cameraBlock = [
    beat.shotSize ? `景别 ${beat.shotSize}` : '',
    beat.cameraAngle ? `机位 ${beat.cameraAngle}` : '',
    beat.focusDepth ? `景深 ${beat.focusDepth}` : '',
    beat.screenDirection ? `屏幕方向 ${beat.screenDirection}` : '',
  ].filter(Boolean).join('；')
  return [
    `一张完整的16:9横屏画面，采用历史电影摄影，画面占满整个画布，是一个单一连续镜头。不要拼贴、分屏、宫格、画中画或分隔线，不要在同一画面重复同一个人物。`,
    `这是一段历史纪录片旁白的唯一配套画面，旁白主题是：${theme}。选择一个决定性时刻承担整段旁白，只保留一个主要动作和一个视觉锚点。`,
    `旁白匹配底线：静音观看时，画面本身必须提供核心人物、动作或结果的直接可见证据。记者询问、店员摇头、人物写字、手拿书本或钱包、钥匙挂回墙上等泛化调查动作，不能替代逃藏、下葬、冲突、发现等旁白真正说出的事件。`,
    `证据路线：优先拍正在发生的直接事件；若事件本身不可见，则拍明确的后果痕迹；身份、数字或档案矛盾才使用可信证据现场配合后期信息层。画面必须有一个来自史实的注意力锚点，不得用虚构冲突补刺激。`,
    `系列风格档案（使用可见摄影机制，不使用姓名式风格捷径）：${styleDirective}。`,
    lookBlock,
    cameraBlock ? `镜头语言：${cameraBlock}。` : '',
    `画面内容：${beat.description}。`,
    `构图要求：完整横屏电影构图，主体位置服从本镜头叙事而不是机械居中，有明确的前景、中景、背景三层纵深，利用引导线把视线引向唯一视觉锚点，光影有明确方向性。`,
    `画质底线：主体和关键动作必须可读，曝光层级、色块面积、景深衰减与材质响应符合系列档案；不要塑料感、磨皮感、廉价CG感、HDR锐化或无来源特效。画面中不要出现任何文字、字幕、数字、水印或标识。`,
    `人物与物件边界：只允许出现当前镜头描述、角色表或参考图中明确存在的主体，不得擅自新增人物、动物、车辆、武器、建筑或道具。`,
    `纪实可信度：所有人物行为、仪式程序、空间关系和摄影机位置必须在现实中成立；旁白未建立的高冲击动作或遗体展示不得自行补充。`,
  ].filter(Boolean).join('\n')
}

function collectReferenceImages(storyboardId: number, sceneId: number | null): string[] {
  const refs: string[] = []
  const links = db
    .select()
    .from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .all()
  if (links.length) {
    const chars = db
      .select()
      .from(schema.characters)
      .where(inArray(schema.characters.id, links.map((l) => l.characterId)))
      .all()
    for (const c of chars) {
      if (c.imageUrl) refs.push(c.imageUrl)
      else if (c.localPath) refs.push(c.localPath)
    }
  }
  if (sceneId) {
    const [scene] = db.select().from(schema.scenes).where(eq(schema.scenes.id, sceneId)).all()
    if (scene?.imageUrl) refs.push(scene.imageUrl)
    else if (scene?.localPath) refs.push(scene.localPath)
  }
  return Array.from(new Set(refs.filter(Boolean)))
}

function loadCharactersForStoryboard(storyboardId: number) {
  const links = db
    .select()
    .from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .all()
  if (!links.length) return []
  const chars = db
    .select()
    .from(schema.characters)
    .where(inArray(schema.characters.id, links.map((l) => l.characterId)))
    .all()
  return chars.map((c) => ({ name: c.name, appearance: c.appearance }))
}

function parseGridCells(sb: any): { theme: string; displayTitle?: string; styleProfile?: string; look?: GridLook; cells: GridCell[] } | null {
  if (!sb.gridCells) return null
  try {
    const parsed = JSON.parse(sb.gridCells)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.cells) && [1, 2].includes(parsed.cells.length)) {
      return {
        theme: String(parsed.theme || ''),
        displayTitle: typeof parsed.displayTitle === 'string' ? parsed.displayTitle : undefined,
        styleProfile: typeof parsed.styleProfile === 'string' ? parsed.styleProfile : undefined,
        look: parsed.look as GridLook | undefined,
        cells: parsed.cells as GridCell[],
      }
    }
    // 兼容旧格式：纯数组
    if (Array.isArray(parsed) && [1, 2].includes(parsed.length)) {
      return { theme: '', cells: parsed as GridCell[] }
    }
    return null
  } catch {
    return null
  }
}

function writeGridCells(
  storyboardId: number,
  theme: string,
  cells: GridCell[],
  look?: GridLook,
  styleProfile?: string,
  displayTitle?: string,
) {
  const [storyboard] = db
    .select({ gridCells: schema.storyboards.gridCells })
    .from(schema.storyboards)
    .where(eq(schema.storyboards.id, storyboardId))
    .all()
  db.update(schema.storyboards)
    .set({
      gridCells: JSON.stringify(mergeGridCellsImageUpdate(
        storyboard?.gridCells,
        theme,
        cells,
        look,
        styleProfile,
        displayTitle,
      )),
      updatedAt: now(),
    })
    .where(eq(schema.storyboards.id, storyboardId))
    .run()
}

export function mergeGridCellsImageUpdate(
  existingRaw: string | null | undefined,
  theme: string,
  cells: GridCell[],
  look?: GridLook,
  styleProfile?: string,
  displayTitle?: string,
) {
  let video: unknown
  try {
    const existing = existingRaw ? JSON.parse(existingRaw) : null
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      video = existing.video
    }
  } catch {
    // Invalid legacy JSON has no metadata worth preserving.
  }

  return {
    theme,
    ...(displayTitle ? { displayTitle } : {}),
    ...(styleProfile ? { styleProfile } : {}),
    ...(look ? { look } : {}),
    cells,
    ...(video ? { video } : {}),
  }
}

/**
 * 阶段1：LLM 单帧设计。只处理 gridCells 为空、旧双格格式或 force 的镜头。
 * 设计结果先写入 gridCells（src 为空，待生成后补）。
 */
export async function decomposeEpisodeForGrid(
  episodeId: number,
  opts: GridPipelineOptions = {},
  onProgress?: ProgressFn,
): Promise<{ decomposed: number; skipped: number; failed: Array<{ storyboardId: number; error: string }> }> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
  const dramaStyle = drama?.style || null
  const styleProfile = resolveHistoryVisualStyle(dramaStyle)
  const allStoryboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
  const storyboards = allStoryboards.filter((sb) => !opts.onlyStoryboardIds || opts.onlyStoryboardIds.includes(sb.id))
  assertSingleImageShotContract(storyboards)

  const targets = storyboards.filter((sb) => {
    if (opts.force) return true
    const parsed = parseGridCells(sb)
    return !parsed || parsed.cells.length !== 1 || parsed.styleProfile !== styleProfile.id
  })
  const failed: Array<{ storyboardId: number; error: string }> = []
  let decomposed = 0
  const planned = new Map<number, GridDecomp>()

  for (let i = 0; i < targets.length; i++) {
    const sb = targets[i]
    onProgress?.(i, targets.length, `拆帧 sb${sb.storyboardNumber}「${sb.title || ''}」`)
    try {
      const globalIndex = allStoryboards.findIndex((candidate) => candidate.id === sb.id)
      const continuityKey = (row: any) => row.sceneId
        ? `scene:${row.sceneId}`
        : `place:${row.location || ''}|time:${row.time || ''}`
      const key = continuityKey(sb)
      let groupStart = globalIndex
      let groupEnd = globalIndex
      while (groupStart > 0 && continuityKey(allStoryboards[groupStart - 1]) === key) groupStart--
      while (groupEnd + 1 < allStoryboards.length && continuityKey(allStoryboards[groupEnd + 1]) === key) groupEnd++
      const groupIndex = globalIndex - groupStart + 1
      const groupTotal = groupEnd - groupStart + 1
      const progress = groupIndex / Math.max(1, groupTotal)
      const stage: GridSequenceContext['stage'] = progress <= 0.25
        ? 'setup'
        : progress <= 0.58
          ? 'development'
          : progress <= 0.82
            ? 'turn'
            : 'landing'
      const previousSb = globalIndex > 0 ? allStoryboards[globalIndex - 1] : null
      const previousPlan = previousSb ? planned.get(previousSb.id) : null
      const previousCells = previousSb && !previousPlan ? parseGridCells(previousSb) : null
      const previousBeat = previousPlan?.beats[0] || previousCells?.cells[0]
      const sequence: GridSequenceContext = {
        stage,
        index: groupIndex,
        total: groupTotal,
        sameSceneAsPrevious: Boolean(previousSb && continuityKey(previousSb) === key),
        ...(previousSb && previousBeat ? {
          previous: {
            narration: String(previousSb.narration || previousSb.description || ''),
            description: String(previousBeat.description || ''),
            shotSize: previousBeat.shotSize,
          },
        } : {}),
        ...(globalIndex + 1 < allStoryboards.length ? {
          nextNarration: String(allStoryboards[globalIndex + 1].narration || allStoryboards[globalIndex + 1].description || ''),
        } : {}),
      }
      const decomp = await decomposeShotForGrid(sb, loadCharactersForStoryboard(sb.id), dramaStyle, sequence)
      const cells: GridCell[] = [{ ...decomp.beats[0] }]
      writeGridCells(sb.id, decomp.theme, cells, decomp.look, styleProfile.id, decomp.displayTitle)
      planned.set(sb.id, decomp)
      decomposed++
    } catch (e: any) {
      failed.push({ storyboardId: sb.id, error: String(e?.message || e).slice(0, 200) })
    }
  }
  onProgress?.(targets.length, targets.length, `拆帧完成 ${decomposed}/${targets.length}`)
  return { decomposed, skipped: storyboards.length - targets.length, failed }
}

/**
 * 阶段2：单张 16:9 图片生成 + 回写。
 * 每镜创建一条 image.generate 任务（走既有任务队列，避免被 reconcile 误判），
 * 等待全部终态后逐镜切分回写。
 */
export async function generateEpisodeGridSheets(
  episodeId: number,
  opts: GridPipelineOptions = {},
  onProgress?: ProgressFn,
): Promise<{ generated: number; skipped: number; failed: Array<{ storyboardId: number; error: string }> }> {
  const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all()
  if (!ep) throw new Error(`Episode ${episodeId} not found`)
  const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all()
  const activeStyleProfile = resolveHistoryVisualStyle(drama?.style || null)
  const configId = ep.imageConfigId ?? getActiveImageConfigId()
  const [imgCfg] = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, configId)).all()
  const imgModel = (() => {
    try {
      const parsed = JSON.parse(imgCfg?.model || '""')
      return Array.isArray(parsed) ? parsed[0] : String(imgCfg?.model || '')
    } catch {
      return String(imgCfg?.model || '')
    }
  })()

  const storyboards = db
    .select()
    .from(schema.storyboards)
    .where(eq(schema.storyboards.episodeId, episodeId))
    .orderBy(schema.storyboards.storyboardNumber)
    .all()
    .filter((sb) => !opts.onlyStoryboardIds || opts.onlyStoryboardIds.includes(sb.id))
  assertSingleImageShotContract(storyboards)

  const targets = storyboards.filter((sb) => {
    const parsed = parseGridCells(sb)
    if (!parsed || parsed.cells.length !== 1) return false
    if (opts.force) return true
    return !sb.gridSheetImage || parsed.cells.some((c) => !c.src)
  })

  const failed: Array<{ storyboardId: number; error: string }> = []

  // 1) 创建 imageGenerations 记录 + image.generate 任务
  const pending: Array<{
    sb: any
    theme: string
    displayTitle?: string
    styleProfile: string
    look?: GridLook
    cells: GridCell[]
    generationId: number
    taskId: number
  }> = []
  for (let i = 0; i < targets.length; i++) {
    const sb = targets[i]
    const { theme, displayTitle, styleProfile, look, cells } = parseGridCells(sb)!
    onProgress?.(i, targets.length * 2, `派发单图 sb${sb.storyboardNumber}「${sb.title || ''}」`)
    try {
      const resolvedStyleProfile = styleProfile || activeStyleProfile.id
      const realityIssues = findRealityContractIssues({
        narration: sb.narration || sb.description,
        location: sb.location,
        description: cells[0].description,
      })
      const evidenceIssues = findNarrationEvidenceContractIssues({
        narration: sb.narration || sb.description,
        description: cells[0].description,
        graphic: cells[0].graphic,
      })
      const contractIssues = [...realityIssues, ...evidenceIssues]
      if (contractIssues.length) {
        throw new Error(`分镜未通过生图前现实可信度或旁白可见证据门禁：${contractIssues.join('；')}`)
      }
      const prompt = buildShotImagePrompt(
        theme || sb.title || '',
        cells[0],
        look,
        resolvedStyleProfile,
      )
      const referenceImages = opts.useReferenceImages === false
        ? []
        : collectReferenceImages(sb.id, sb.sceneId)
      const ts = now()
      const res = db
        .insert(schema.imageGenerations)
        .values({
          storyboardId: sb.id,
          dramaId: ep.dramaId,
          prompt,
          model: imgModel || null,
          provider: imgCfg?.provider || null,
          size: '1920x1080',
          frameType: 'single_frame_16x9',
          referenceImages: referenceImages.length ? JSON.stringify(referenceImages) : null,
          status: 'pending',
          createdAt: ts,
          updatedAt: ts,
        })
        .run()
      const generationId = Number(res.lastInsertRowid)
      const task = createTask({
        type: 'image.generate',
        dramaId: ep.dramaId,
        episodeId,
        scopeType: 'storyboard',
        scopeId: sb.id,
        idempotencyKey: `image.generate:storyboard:single16x9:${sb.id}:${generationId}`,
        payload: { image_generation_id: generationId, frame_type: 'single_frame_16x9', config_id: configId },
      })
      pending.push({ sb, theme, displayTitle, styleProfile: resolvedStyleProfile, look, cells, generationId, taskId: task.id })
    } catch (e: any) {
      failed.push({ storyboardId: sb.id, error: String(e?.message || e).slice(0, 200) })
    }
  }

  // 2) 等待任务终态
  const terminal = new Set(['succeeded', 'failed', 'canceled', 'stale'])
  const deadline = Date.now() + Math.max(10, pending.length * 3) * 60_000
  while (pending.length && Date.now() < deadline) {
    const rows = db
      .select()
      .from(schema.creationTasks)
      .where(inArray(schema.creationTasks.id, pending.map((p) => p.taskId)))
      .all()
    const done = rows.filter((r) => terminal.has(r.status)).length
    onProgress?.(targets.length + done, targets.length * 2, `单图生成中 ${done}/${pending.length}`)
    if (done >= pending.length) break
    await new Promise((r) => setTimeout(r, 5000))
  }

  // 3) 逐镜直接回写完整图片
  let generated = 0
  for (const p of pending) {
    const [record] = db.select().from(schema.imageGenerations).where(eq(schema.imageGenerations.id, p.generationId)).all()
    if (!record || record.status !== 'completed' || !record.localPath) {
      failed.push({ storyboardId: p.sb.id, error: record?.errorMsg || `status: ${record?.status || 'missing'}` })
      continue
    }
    try {
      const nextCells: GridCell[] = [{ ...p.cells[0], src: record.localPath }]
      db.update(schema.storyboards)
        .set({ gridSheetImage: record.localPath, updatedAt: now() })
        .where(eq(schema.storyboards.id, p.sb.id))
        .run()
      writeGridCells(p.sb.id, p.theme, nextCells, p.look, p.styleProfile, p.displayTitle)
      generated++
    } catch (e: any) {
      failed.push({ storyboardId: p.sb.id, error: String(e?.message || e).slice(0, 200) })
    }
  }

  onProgress?.(targets.length * 2, targets.length * 2, `单图完成 ${generated}/${targets.length}`)
  return { generated, skipped: storyboards.length - targets.length, failed }
}

/** 整集一键：拆帧 → 生成。 */
export async function runEpisodeGridPipeline(
  episodeId: number,
  opts: GridPipelineOptions = {},
  onProgress?: ProgressFn,
) {
  const decomp = await decomposeEpisodeForGrid(episodeId, opts, onProgress)
  const gen = await generateEpisodeGridSheets(episodeId, opts, onProgress)
  return {
    episode_id: episodeId,
    decomposed: decomp.decomposed,
    generated: gen.generated,
    failed: [...decomp.failed, ...gen.failed],
  }
}
