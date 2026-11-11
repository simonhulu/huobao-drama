import {tsImport} from 'tsx/esm/api'

process.once('disconnect', () => process.exit())
process.once('message', async ({input, projectRoot, databasePath}) => {
  let response
  try {
    const {checkSourceMediaReferences} = await tsImport('./storage-source-references.ts', import.meta.url)
    const references = await checkSourceMediaReferences(input, {projectRoot, databasePath})
    response = {ok: true, references}
  } catch (error) {
    response = {ok: false, error: error instanceof Error ? error.message : String(error)}
    process.exitCode = 1
  }
  process.send(response, () => process.disconnect())
})
