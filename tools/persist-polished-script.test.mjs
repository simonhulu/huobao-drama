import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { persistPolishedScript, slugifyTitle } from './persist-polished-script.mjs'

test('persists clean spoken text with cheat-compatible hash and notes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-polished-script-'))
  try {
    fs.mkdirSync(path.join(root, 'drafts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'drafts', 'polished.txt'), '\uFEFF第一段。\r\n\r\n第二段。  ', 'utf8')
    fs.writeFileSync(path.join(root, 'drafts', 'notes.md'), '# 编辑说明\n', 'utf8')

    const result = persistPolishedScript({
      root,
      input: 'drafts/polished.txt',
      notes: 'drafts/notes.md',
      title: '大礼议：顺我者昌，逆我者亡？',
      date: '2026-07-13',
    })
    const content = '第一段。\n\n第二段。\n'
    const id = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12)
    assert.equal(result.articleId, id)
    assert.equal(result.scriptPath, `scripts/2026-07-13_${id}_${slugifyTitle('大礼议：顺我者昌，逆我者亡？')}.md`)
    assert.equal(fs.readFileSync(path.join(root, result.scriptPath), 'utf8'), content)
    assert.match(result.notesPath, new RegExp(`^scripts/polish-notes/2026-07-13_${id}_`))
    assert.equal(fs.readFileSync(path.join(root, result.notesPath), 'utf8'), '# 编辑说明\n')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('uses a readable fallback when a title has no safe characters', () => {
  assert.equal(slugifyTitle('?!'), '口播稿')
})

