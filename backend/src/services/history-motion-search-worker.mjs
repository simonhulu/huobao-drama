import {HuashengMaterialLibrary} from './huasheng-material-library.mjs'

process.once('message', ({databasePath, queries}) => {
  let library, response
  try {
    if (!Array.isArray(queries) || queries.length > 5) throw Error('Invalid bounded material queries')
    library = new HuashengMaterialLibrary({databasePath, readonly: true})
    process.send({type: 'started'})
    const rows = queries.flatMap(query => library.search(query)).map(row => ({
      assetId: row.assetId, rank: row.rank, status: row.status, sourceCaption: row.sourceCaption, text: row.text,
      query: row.query, duration: row.duration, width: row.width, height: row.height, fps: row.fps,
      localPath: row.localPath, sha256: row.sha256, projectId: row.projectId, clipId: row.clipId,
    }))
    const filesByAsset = Object.fromEntries([...new Set(rows.map(row => String(row.assetId)))].map(assetId => [assetId,
      library.findFiles(assetId).map(file => ({filePath: file.filePath, sha256: file.sha256,
        media: {duration: file.media?.duration, width: file.media?.width, height: file.media?.height}})),
    ]))
    response = {ok: true, rows, filesByAsset}
    if (Buffer.byteLength(JSON.stringify(response)) > 4 * 1024 * 1024) throw Error('Material search response exceeds 4 MiB')
  } catch (error) {
    response = {ok: false, error: error instanceof Error ? error.message : String(error)}
    process.exitCode = 1
  } finally {library?.close()}
  process.send(response, () => process.disconnect())
})
process.once('disconnect', () => process.exit())
