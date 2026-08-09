import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const polishRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const skillsRoot = resolve(polishRoot, '..')
const polishSkill = readFileSync(resolve(polishRoot, 'SKILL.md'), 'utf8')
const dharmaSkill = readFileSync(resolve(skillsRoot, 'dharma-video-script/SKILL.md'), 'utf8')
const productionWritingDocs = [
  polishSkill,
  readFileSync(resolve(polishRoot, 'references/editorial-audit.md'), 'utf8'),
  readFileSync(resolve(polishRoot, 'references/persistence.md'), 'utf8'),
  readFileSync(resolve(polishRoot, 'references/writer-pass.md'), 'utf8'),
].join('\n')

test('explicit script skill invocation is authoritative and never becomes a workflow menu', () => {
  assert.match(polishSkill, /explicit `\$polish-video-script` invocation pins this skill/iu)
  assert.match(polishSkill, /never output a ranked menu/iu)
  assert.match(polishSkill, /Domain Guard Resolution \(Automatic, Not A Workflow\)/u)
  assert.match(dharmaSkill, /explicit `\$dharma-video-script` invocation pins this skill/iu)
  assert.match(dharmaSkill, /do not supersede that request/iu)
  assert.match(dharmaSkill, /Never present .* as a workflow menu/iu)
})

test('scripture protection is an internal polish guard rather than a third workflow', () => {
  assert.match(polishSkill, /Domain Guard Resolution \(Automatic, Not A Workflow\)/u)
  assert.match(polishSkill, /\.\.\/dharma-video-script\/references\/concept-boundary\.md/u)
  assert.match(polishSkill, /\.\.\/dharma-video-script\/agents\/scripture-fact-checker\.md/u)
  assert.match(polishSkill, /additional internal audit, not a handoff/iu)
  assert.match(polishSkill, /For historical material, use the creator's story contract/su)
})

test('historical演义 writing is story-first without a historical-precision gate', () => {
  assert.doesNotMatch(polishSkill, /history-fact-checker/iu)
  assert.match(polishSkill, /historical-story-reviewer/iu)
  assert.match(polishSkill, /mandatory story-structure gate/iu)
  assert.doesNotMatch(polishSkill, /Rerun all required reviewers \(historical story, facts,/iu)
  assert.match(polishSkill, /Historical precision is not a goal, a gate, or an audit target/u)
  assert.match(polishSkill, /no `科普` or `考据` mode/iu)
  assert.match(polishSkill, /story-material pool/u)
  assert.match(polishSkill, /every paragraph changes the\s+story state/u)
  assert.doesNotMatch(polishSkill, /scan-fact-anchors\.mjs/u)
})

test('production writing does not depend on the unvalidated book-craft runtime', () => {
  assert.doesNotMatch(productionWritingDocs, /book-craft/iu)
  assert.doesNotMatch(productionWritingDocs, /retrieve-writing-knowledge/iu)
  assert.doesNotMatch(productionWritingDocs, /scan-hard-banned-expressions/iu)
  assert.doesNotMatch(productionWritingDocs, /(?:knowledge|sources)\/books/iu)
})
