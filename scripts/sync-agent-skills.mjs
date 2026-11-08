import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const excludedDirectories = new Set([
  '.git', 'node_modules', '__pycache__', '.cache', 'cache', 'caches',
  '.auth', '.auth-xhs', '.auth-linkedin', '.ssh', '.secrets', 'secrets', '.credentials', 'credentials', '.runtime',
  '.venv', 'venv', '.logs', 'logs', 'tmp', 'temp',
  'out', 'outputs', 'dist', 'build', 'coverage', '.next',
])
const excludedFiles = /^(?:\.env(?:\..*)?|\.DS_Store|auth\.json|credentials(?:\.json)?|secrets(?:\.json)?|id_rsa|id_ed25519)$|\.(?:log|pyc|pyo|pem|key|p12|pfx)$/i
const nativeMagic = new Set(['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const inside = (candidate, parent) => candidate === parent || candidate.startsWith(parent + path.sep)

export async function collectSkills({ projectRoot = process.cwd(), home = os.homedir(), stage } = {}) {
  projectRoot = path.resolve(projectRoot)
  home = path.resolve(home)
  const roots = [
    { key: 'project-codex', source: path.join(projectRoot, '.codex/skills'), destination: 'project/.codex/skills' },
    { key: 'project-agents', source: path.join(projectRoot, '.agents/skills'), destination: 'project/.agents/skills' },
    { key: 'user-codex', source: path.join(home, '.codex/skills'), destination: 'user/.codex/skills' },
    { key: 'user-agents', source: path.join(home, '.agents/skills'), destination: 'user/.agents/skills' },
  ]
  const manifest = { version: 1, createdAt: new Date().toISOString(), staged: Boolean(stage), roots: [], skills: [], skipped: [], files: 0, bytes: 0 }
  const candidates = []
  for (const root of roots) {
    const summary = { ...root, skills: 0, files: 0, bytes: 0 }
    manifest.roots.push(summary)
    let children
    try { children = await fs.readdir(root.source, { withFileTypes: true }) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      manifest.skipped.push({ root: root.key, path: '', reason: 'missing-root' })
      continue
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name.startsWith('.')) continue
      const source = path.join(root.source, child.name)
      try {
        const real = await fs.realpath(source)
        if (!(await fs.stat(real)).isDirectory() || !(await fs.stat(path.join(real, 'SKILL.md'))).isFile()) continue
        candidates.push({ root, summary, name: child.name, source, real })
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error
        manifest.skipped.push({ root: root.key, path: child.name, reason: child.isSymbolicLink() ? 'broken-link' : 'no-skill-document' })
      }
    }
  }
  if (stage) {
    stage = path.resolve(stage)
    let existing = stage
    const missing = []
    while (true) {
      try { existing = await fs.realpath(existing); break }
      catch (error) {
        if (error.code !== 'ENOENT') throw error
        missing.unshift(path.basename(existing)); existing = path.dirname(existing)
      }
    }
    const canonicalStage = path.join(existing, ...missing)
    if (candidates.some(candidate => inside(canonicalStage, candidate.real) || inside(stage, candidate.source))) {
      throw new Error('The staging directory must not be inside a source skill')
    }
    await fs.mkdir(path.dirname(stage), { recursive: true })
    await fs.mkdir(stage)
  }
  for (const candidate of candidates) {
    const entry = { root: candidate.root.key, name: candidate.name, destination: `${candidate.root.destination}/${candidate.name}`, files: 0, bytes: 0 }
    const walk = async (source, relative, ancestors) => {
      let real, stat
      try { real = await fs.realpath(source); stat = await fs.stat(real) }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error
        manifest.skipped.push({ root: entry.root, path: `${entry.name}/${relative}`, reason: 'broken-link' })
        return
      }
      const name = path.basename(source)
      if (stat.isDirectory()) {
        if (excludedDirectories.has(name)) return
        if (ancestors.has(real)) {
          manifest.skipped.push({ root: entry.root, path: `${entry.name}/${relative}`, reason: 'link-cycle' })
          return
        }
        const next = new Set(ancestors).add(real)
        const children = (await fs.readdir(real)).sort()
        for (const child of children) await walk(path.join(real, child), path.join(relative, child), next)
      } else if (stat.isFile() && !excludedFiles.test(name)) {
        const handle = await fs.open(real, 'r')
        const magic = Buffer.alloc(4)
        try { await handle.read(magic, 0, 4, 0) } finally { await handle.close() }
        if (nativeMagic.has(magic.toString('hex')) || magic.subarray(0, 2).toString('ascii') === 'MZ') {
          manifest.skipped.push({ root: entry.root, path: `${entry.name}/${relative}`, reason: 'native-binary' })
          return
        }
        if (stage) {
          const target = path.join(stage, entry.destination, relative)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.copyFile(real, target, fs.constants.COPYFILE_EXCL)
          await fs.chmod(target, stat.mode & 0o777)
        }
        entry.files++
        entry.bytes += stat.size
      }
    }
    await walk(candidate.real, '', new Set())
    candidate.summary.skills++
    candidate.summary.files += entry.files
    candidate.summary.bytes += entry.bytes
    manifest.files += entry.files
    manifest.bytes += entry.bytes
    manifest.skills.push(entry)
  }
  if (stage) await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  return manifest
}

async function main() {
  const options = {}
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index]
    const keys = { '--project-root': 'projectRoot', '--home': 'home', '--stage': 'stage' }
    if (!(argument in keys) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
      throw new Error('Usage: node scripts/sync-agent-skills.mjs [--project-root DIR] [--home DIR] [--stage NEW_DIR]')
    }
    options[keys[argument]] = process.argv[++index]
  }
  const manifest = await collectSkills(options)
  console.log(JSON.stringify({ staged: manifest.staged, stage: options.stage ? path.resolve(options.stage) : undefined,
    roots: manifest.roots, files: manifest.files, bytes: manifest.bytes, skipped: manifest.skipped }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
