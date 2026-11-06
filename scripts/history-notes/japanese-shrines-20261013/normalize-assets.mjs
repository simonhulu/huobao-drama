import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, '../../..')
const workDir = path.join(root, 'data/temp/japanese-shrines-20261013')
const sourceDir = path.join(workDir, 'images')
const outputDir = path.join(workDir, 'images-normalized')
const inputLedgerPath = path.join(workDir, 'asset-ledger.json')
const outputLedgerPath = path.join(workDir, 'normalized-asset-ledger.json')
const requireFromRoot = createRequire(path.join(root, 'backend/package.json'))
const sharp = requireFromRoot('sharp')

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

const input = JSON.parse(fs.readFileSync(inputLedgerPath, 'utf8'))
fs.mkdirSync(outputDir, { recursive: true })
const ledger = {}
const missing = []

for (const number of Object.keys(input.ledger).sort((a, b) => Number(a) - Number(b))) {
  const item = input.ledger[number]
  const sourceFile = item.frozenFile
  const padded = number.padStart(3, '0')
  const normalizedFile = path.join(outputDir, `${padded}.png`)
  if (!fs.existsSync(sourceFile)) {
    missing.push({ storyboardNumber: Number(number), status: 'missing', sourceFile })
    continue
  }

  await sharp(sourceFile)
    .resize(1920, 1080, { fit: 'fill' })
    .png()
    .toFile(normalizedFile)
  const metadata = await sharp(normalizedFile).metadata()
  ledger[number] = {
    ...item,
    normalizedFile,
    width: metadata.width,
    height: metadata.height,
    sha256: sha256(normalizedFile),
    bytes: fs.statSync(normalizedFile).size,
  }
}

for (let i = 1; i <= input.imageCount; i += 1) {
  if (!ledger[String(i)]) missing.push({ storyboardNumber: i, status: 'missing-normalized' })
}

writeJson(outputLedgerPath, {
  schemaVersion: 1,
  normalizedAt: new Date().toISOString(),
  imageCount: Object.keys(ledger).length,
  ledger,
  missing,
})

console.log(JSON.stringify({ outputDir, imageCount: Object.keys(ledger).length, missingCount: missing.length, missing }, null, 2))
if (missing.length) process.exitCode = 1
