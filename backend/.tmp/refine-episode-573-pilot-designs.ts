import { eq, inArray } from 'drizzle-orm'
import { db, schema } from '../src/db/index.js'

const refinements = new Map<number, {
  theme: string
  displayTitle: string
  look: { palette: string; lighting: string; mood: string }
  cell: Record<string, unknown>
}>([
  [4345, {
    theme: '1855年克利夫兰，十六岁少年走向第一份工作',
    displayTitle: '1855年，克利夫兰',
    look: {
      palette: '冷灰街面、陈年砖红、深褐呢料，商行门内仅保留小面积琥珀暖光',
      lighting: '清晨冷天光从右后方覆盖街道，商行门内暖光从左前方溢出，只勾亮少年的脸与肩',
      mood: '急促城市流动中，一个少年做出决定',
    },
    cell: {
      description: '低机位贴近1855年克利夫兰湿冷的土石街道，一辆满载木箱的马车从前景右向左擦过形成强烈遮挡；遮挡后方，十六岁的洛克菲勒穿磨旧但整洁的深色外套，快步穿过车流，正抬脚迈向左侧小商行敞开的暖光门口。少年位于左三分线，马车轮与扬尘在前景，中景是少年和门槛，背景保留码头桅杆与砖木商铺，画面没有任何可读招牌。',
      shotSize: 'wide',
      cameraAngle: 'low_angle',
      focusDepth: 'deep',
      screenDirection: 'right_to_left',
      move: 'push',
      enter: 'cut',
      enterFrames: 0,
    },
  }],
  [4347, {
    theme: '年薪只有三百美元的簿记职位',
    displayTitle: '年薪300美元',
    look: {
      palette: '旧象牙纸、深胡桃木、冷灰外套，小面积旧铜硬币反光',
      lighting: '商行高窗冷天光压住室内，桌面一束窄暖光只照亮稀少硬币和少年的手',
      mood: '职位来之不易，报酬却十分有限',
    },
    cell: {
      description: '商行柜台的近景证据现场：老板的手把一小摞硬币和一张字迹完全不可辨的雇佣纸推到桌面中央，十六岁洛克菲勒的手停在桌沿，身体在右侧前倾聆听；巨大的厚账本与稀少硬币形成清楚尺度反差。前景为磨损柜台，中景只保留两双手、硬币和账本，背景货架压暗虚化，任何纸面文字都不可读。',
      shotSize: 'close',
      cameraAngle: 'over_shoulder',
      focusDepth: 'shallow',
      screenDirection: 'left_to_right',
      move: 'hold',
      enter: 'cut',
      enterFrames: 0,
      graphic: {
        type: 'bignum',
        value: 300,
        prefix: '$',
        suffix: '美元',
        label: '年薪',
      },
    },
  }],
  [4350, {
    theme: '收到的钱并不等于可以留下的钱',
    displayTitle: '钱还没有结束',
    look: {
      palette: '青灰阴影、旧象牙票据、胡桃木与小面积琥珀硬币高光',
      lighting: '左侧高窗光先落在打开的现金抽屉，再延伸到右侧等待支付的货款票据，远墙低两档',
      mood: '第一次看见收入背后的连续责任',
    },
    cell: {
      description: '十六岁洛克菲勒刚把客户交来的硬币放进打开的现金抽屉，老板随即从右侧把一摞供应商货单和下一批进货样品压到抽屉旁；少年双手停在两者之间，视线从刚入账的硬币转向马上要付出的货款。前景是现金抽屉边缘，中景是硬币、货单和少年手部，背景可见等待搬运的新货木箱，纸面字迹全部模糊不可辨。',
      shotSize: 'medium',
      cameraAngle: 'eye_level',
      focusDepth: 'medium',
      screenDirection: 'left_to_right',
      move: 'push',
      enter: 'dissolve',
      enterFrames: 12,
    },
  }],
  [4351, {
    theme: '回款立即变成下一批进货的本钱',
    displayTitle: '现金必须流动',
    look: {
      palette: '深墨绿、旧木棕、冷灰布料，硬币和新货麻绳保留暖金点缀',
      lighting: '商行门口冷天光与柜台暖侧光交汇，光线沿钱币传递方向形成单一视线通道',
      mood: '资金在一次交易结束前就进入下一次交易',
    },
    cell: {
      description: '同一商行柜台内的决定性瞬间：老板刚从左侧顾客手中收下一袋硬币，手臂不停，立刻把其中一把硬币递给右侧送来新货木箱的批发商；十六岁洛克菲勒站在两人之间记录并看清这次连续传递。前景顾客手臂形成遮挡，中景钱币正从老板手中流向批发商，背景搬工把下一批木箱抬进门，所有标签与账页均无可读文字。',
      shotSize: 'medium',
      cameraAngle: 'eye_level',
      focusDepth: 'deep',
      screenDirection: 'left_to_right',
      move: 'hold',
      enter: 'cut',
      enterFrames: 0,
      graphic: {
        type: 'card',
        title: '现金循环',
        lines: ['借钱进货', '回款再进货'],
      },
    },
  }],
  [4352, {
    theme: '卖不出去的货把整盘账拖入危险',
    displayTitle: '货一压，账就坏',
    look: {
      palette: '煤灰、旧木棕、脏象牙麻布，空钱箱边缘有一线冷铁色',
      lighting: '仓库高窗冷光横扫积灰木箱，少年与空现金抽屉处只有微弱暖反光',
      mood: '货物没有消失，却把现金彻底困住',
    },
    cell: {
      description: '狭窄商行仓库被一排排积灰的滞销木箱堵到几乎无法通行，十六岁洛克菲勒站在通道尽头，左手扶着塞满货物却无人搬动的木箱，右侧前景是拉开后几乎空空的现金抽屉；一名搬工推着空手推车停在门口，没有买家出现。木箱形成压迫性的纵深墙，货物规模与空钱箱构成不可逆后果，箱体无任何可读标记。',
      shotSize: 'wide',
      cameraAngle: 'eye_level',
      focusDepth: 'deep',
      screenDirection: 'static',
      move: 'pull',
      enter: 'dissolve',
      enterFrames: 12,
    },
  }],
])

const rows = db.select().from(schema.storyboards)
  .where(inArray(schema.storyboards.id, [...refinements.keys()]))
  .all()
if (rows.length !== refinements.size) throw new Error('Pilot refinement target is missing')

db.transaction((tx) => {
  const now = new Date().toISOString()
  for (const row of rows) {
    const refinement = refinements.get(row.id)!
    const parsed = JSON.parse(row.gridCells || '{}')
    if (!Array.isArray(parsed.cells) || parsed.cells.length !== 1) {
      throw new Error(`Storyboard ${row.id} has no single-cell grid design`)
    }
    const gridCells = JSON.stringify({
      ...parsed,
      theme: refinement.theme,
      displayTitle: refinement.displayTitle,
      styleProfile: 'commercial_teal_orange',
      look: refinement.look,
      cells: [{ ...refinement.cell }],
    })
    tx.update(schema.storyboards)
      .set({ gridCells, gridSheetImage: null, updatedAt: now })
      .where(eq(schema.storyboards.id, row.id))
      .run()
  }

  tx.update(schema.storyboards).set({
    videoPrompt: [
      'Use the approved storyboard image as the exact first-frame identity, costume, architecture, lighting, palette, and composition reference.',
      '0-2 seconds: at wagon-wheel height, a loaded horse cart sweeps across the immediate foreground from right to left, creating a fast natural wipe; through the moving wheel spokes the sixteen-year-old Rockefeller snaps into view on the curb, already moving with purpose.',
      '2-5 seconds: the camera makes one smooth low tracking push with him as he crosses the damp dirt street and steps toward the open warm doorway of the small merchant house; his coat hem moves in the wind, hooves strike the road, dust lifts, and the door swings slightly.',
      'End at the threshold before he begins work. Preserve his face and body with no morphing, preserve 1855 Cleveland materials and traffic, physically realistic motion and camera parallax, no slow motion, no modern objects, no invented danger, no readable signs, no text, no subtitles, no watermark.',
    ].join(' '),
    updatedAt: now,
  }).where(eq(schema.storyboards.id, 4345)).run()
})

console.log(JSON.stringify({ refined: [...refinements.keys()], openingVideoPrompt: true }, null, 2))
