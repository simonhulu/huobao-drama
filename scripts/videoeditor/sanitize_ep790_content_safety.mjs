#!/usr/bin/env node

/**
 * 修复 episode 790 三个确定性内容安全/合同拦截的画格。
 *
 * 背景：grid.episode_generate 对这三个 panel 每次生成都失败，不是网络故障：
 *  - sb-8945：角色身份「头盔下血染面庞」与连续性锚点「血迹斑驳」泄漏进提示词
 *  - sb-9020：panel 描述里「当场毒发，脑子烂了，死了」未被 safeStoryboardDescription
 *      （VIOLENCE_PATTERN 不含 毒/烂/死了）清洗
 *  - sb-8993：panel 描述缺下葬可见证据（棺/墓穴/入土），被生图前合同门禁拦截
 *
 * 修复原则（narrative-storyboard.md Safe Prompt Compilation）：
 * 保留因果、目标、方向与后果，只把图形化表达改成可见的非图形化舞台处理。
 * 旁白主轨（pre_tts / narration）与 TTS 时间轴完全不动。
 */

import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../..')
const require = createRequire(path.join(root, 'backend/package.json'))
const Database = require('better-sqlite3')

const EPISODE_ID = 790
const PLAN_ID = 72

function main() {
  const db = new Database(path.join(root, 'data/huobao_drama.db'))

  const log = (msg) => console.log(msg)

  // ---- Fix 1: 李嗣昭 角色外观去血 ----
  const li = db.prepare('SELECT id, appearance FROM characters WHERE id = 939').get()
  if (!li) {
    log('⚠ 未找到角色 939（李嗣昭），跳过外观修复')
  } else {
    log(`角色 939 外观 BEFORE: ${li.appearance}`)
    db.prepare('UPDATE characters SET appearance = ? WHERE id = 939')
      .run('五代重甲武将，头盔压住额头，面庞刚毅，目光沉毅')
    const after = db.prepare('SELECT appearance FROM characters WHERE id = 939').get().appearance
    log(`角色 939 外观 AFTER : ${after}`)
  }

  // ---- Fix 2: seq-04 中 sb-8945 的连续性锚点去血 ----
  const s4 = db.prepare('SELECT design_json FROM narrative_sequences WHERE plan_id = ? AND seq_key = ?').get(PLAN_ID, 'seq-04')
  if (s4) {
    const d4 = JSON.parse(s4.design_json)
    let changed = 0
    for (const p of d4.panels || []) {
      if (p.panelKey === 'sb-8945' && Array.isArray(p.continuityAnchors)) {
        p.continuityAnchors = p.continuityAnchors.map((a) => {
          const n = String(a).replace(/血迹斑驳/g, '铜锈斑驳').replace(/带血羽箭/g, '羽箭').replace(/血污/g, '旧痕').replace(/血糊住/g, '刀刻般')
          if (n !== a) changed++
          return n
        })
      }
    }
    if (changed) {
      db.prepare('UPDATE narrative_sequences SET design_json = ? WHERE plan_id = ? AND seq_key = ?')
        .run(JSON.stringify(d4), PLAN_ID, 'seq-04')
      log(`seq-04 sb-8945 锚点清洗 ${changed} 处`)
    } else {
      log('seq-04 sb-8945 无锚点需要清洗')
    }
  }

  // ---- Fix 3: sb-8993 panel 描述补下葬可见证据（非图形化） ----
  const p8993 = db.prepare('SELECT description FROM storyboard_panels WHERE panel_key = ?').get('sb-8993')
  if (p8993) {
    log(`sb-8993 panel 描述 BEFORE: ${p8993.description}`)
    const newDesc = '王宗寿跪在熊耳山三赵村新挖的墓穴前，将十八具裹着白布的遗骸依次放入棺木，覆土立冢——一个义子，给亡了的「父族」收尸。'
    db.prepare('UPDATE storyboard_panels SET description = ? WHERE panel_key = ?').run(newDesc, 'sb-8993')
    log(`sb-8993 panel 描述 AFTER : ${newDesc}`)
  }

  // ---- Fix 4: seq-10 中 sb-8993 的锚点去「裹尸」措辞 ----
  const s10 = db.prepare('SELECT design_json FROM narrative_sequences WHERE plan_id = ? AND seq_key = ?').get(PLAN_ID, 'seq-10')
  if (s10) {
    const d10 = JSON.parse(s10.design_json)
    let changed = 0
    for (const p of d10.panels || []) {
      if (p.panelKey === 'sb-8993' && Array.isArray(p.continuityAnchors)) {
        p.continuityAnchors = p.continuityAnchors.map((a) => {
          const n = String(a).replace(/裹尸/g, '覆体的棺椁').replace(/遗骸/g, '遗物')
          if (n !== a) changed++
          return n
        })
      }
    }
    if (changed) {
      db.prepare('UPDATE narrative_sequences SET design_json = ? WHERE plan_id = ? AND seq_key = ?')
        .run(JSON.stringify(d10), PLAN_ID, 'seq-10')
      log(`seq-10 sb-8993 锚点清洗 ${changed} 处`)
    } else {
      log('seq-10 sb-8993 无锚点需要清洗')
    }
  }

  // ---- Fix 5: sb-9020 panel 描述去毒发/烂/死措辞（保留后果） ----
  const p9020 = db.prepare('SELECT description FROM storyboard_panels WHERE panel_key = ?').get('sb-9020')
  if (p9020) {
    log(`sb-9020 panel 描述 BEFORE: ${p9020.description}`)
    const newDesc = '宴席上申渐高夺过两杯酒一饮而尽，杯盏脱手坠地，席间骤然死寂，众人惊立当场。'
    db.prepare('UPDATE storyboard_panels SET description = ? WHERE panel_key = ?').run(newDesc, 'sb-9020')
    log(`sb-9020 panel 描述 AFTER : ${newDesc}`)
  }

  db.close()
  log('\n内容安全清洗完成（未触碰旁白主轨 / TTS 时间轴）')
}

main()
