import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { generateScienceCoverPosters } from '../src/services/science-cover-poster.js'
const reportDir = path.resolve('../data/reports/science-posters-20261030')
const ids = process.argv.slice(2)
for (const id of ids) {
  const jobDir = path.resolve('../data/science-pop/jobs', id)
  const job = JSON.parse(await fs.readFile(path.join(jobDir, 'job.json'), 'utf8'))
  const contentHash = createHash('sha256').update(JSON.stringify([job.title, job.script, job.sourceTitle, ''])).digest('hex').slice(0, 16)
  const directory = path.join(jobDir, 'covers', `poster-1-${contentHash}`)
  const result = await generateScienceCoverPosters({ title: job.title, script: job.script, sourceTitle: job.sourceTitle, instruction: '', directory, revision: 1 }, {
    signal: new AbortController().signal, report: message => console.log(JSON.stringify({ id, message })),
  })
  await fs.writeFile(path.join(reportDir, `${id}.json`), JSON.stringify({ id, directory, ...result }, null, 2))
  console.log(JSON.stringify({ id, ...result }))
}
