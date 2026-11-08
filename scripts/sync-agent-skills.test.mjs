import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectSkills } from './sync-agent-skills.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-sync-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const projectRoot = path.join(root, 'project'), home = path.join(root, 'home')
  const skill = path.join(projectRoot, '.agents/skills/science')
  await fs.mkdir(skill, { recursive: true })
  await fs.writeFile(path.join(skill, 'SKILL.md'), '# Science')
  return { root, projectRoot, home, skill }
}

test('inventory is read-only; staging resolves valid links and excludes credentials and dependencies', async t => {
  const f = await fixture(t), shared = path.join(f.root, 'shared')
  await fs.mkdir(shared)
  await fs.writeFile(path.join(shared, 'SKILL.md'), '# Shared')
  await fs.mkdir(path.join(f.home, '.codex/skills'), { recursive: true })
  await fs.symlink(shared, path.join(f.home, '.codex/skills/shared'))
  await fs.symlink(path.join(f.root, 'missing'), path.join(f.home, '.codex/skills/broken'))
  await fs.mkdir(path.join(f.skill, 'node_modules'))
  await fs.writeFile(path.join(f.skill, 'node_modules/library.js'), 'dependency')
  await fs.writeFile(path.join(f.skill, '.env.production'), 'SECRET=private')
  await fs.mkdir(path.join(f.skill, 'out'))
  await fs.writeFile(path.join(f.skill, 'out/final.mp4'), 'generated output')
  await fs.mkdir(path.join(f.skill, 'bin'))
  await fs.writeFile(path.join(f.skill, 'bin/native'), Buffer.from('7f454c4601020304', 'hex'))
  await fs.writeFile(path.join(f.skill, 'run.mjs'), 'console.log("ok")')
  await fs.chmod(path.join(f.skill, 'run.mjs'), 0o755)
  const inventory = await collectSkills(f)
  assert.equal(inventory.staged, false)
  assert.equal(inventory.skills.length, 2)
  assert.ok(inventory.skipped.some(item => item.reason === 'broken-link'))
  const stage = path.join(f.root, 'stage')
  const staged = await collectSkills({ ...f, stage })
  assert.equal(staged.files, 3)
  assert.ok(staged.skipped.some(item => item.reason === 'native-binary'))
  const target = path.join(stage, 'project/.agents/skills/science')
  assert.equal(await fs.readFile(path.join(stage, 'user/.codex/skills/shared/SKILL.md'), 'utf8'), '# Shared')
  assert.equal((await fs.stat(path.join(target, 'run.mjs'))).mode & 0o777, 0o755)
  await assert.rejects(fs.stat(path.join(target, '.env.production')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(target, 'node_modules')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(target, 'out')), { code: 'ENOENT' })
  await assert.rejects(collectSkills({ ...f, stage }), { code: 'EEXIST' })
})

test('nested cycles and broken links are skipped without emitting machine-specific symlinks', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.skill, 'references'))
  await fs.symlink(f.skill, path.join(f.skill, 'references/parent'))
  await fs.symlink(path.join(f.root, 'missing'), path.join(f.skill, 'references/broken'))
  const stage = path.join(f.root, 'stage')
  const result = await collectSkills({ ...f, stage })
  assert.equal(result.files, 1)
  assert.ok(result.skipped.some(item => item.reason === 'link-cycle'))
  assert.ok(result.skipped.some(item => item.reason === 'broken-link'))
  await assert.rejects(fs.stat(path.join(stage, 'project/.agents/skills/science/references')), { code: 'ENOENT' })
})

test('staging inside a source skill is rejected before writing anything', async t => {
  const f = await fixture(t), stage = path.join(f.skill, 'stage')
  await assert.rejects(collectSkills({ ...f, stage }), /must not be inside/)
  await assert.rejects(fs.stat(stage), { code: 'ENOENT' })
  const alias = path.join(f.root, 'alias')
  await fs.symlink(f.skill, alias)
  await assert.rejects(collectSkills({ ...f, stage: path.join(alias, 'nested', 'stage') }), /must not be inside/)
  await assert.rejects(fs.stat(path.join(f.skill, 'nested')), { code: 'ENOENT' })
})
