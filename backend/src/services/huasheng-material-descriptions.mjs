const text = value => typeof value === 'string' ? value.trim() : ''

function originalVideo(metadata) {
  try {
    const video = JSON.parse(metadata)?.video
    const id = typeof video?.id === 'number' && Number.isSafeInteger(video.id) ? String(video.id) : text(video?.id)
    return id ? { id, caption: text(video.caption) } : null
  } catch { return null }
}

/** Recover source annotations from saved originals without touching media or recommendation checkpoints. */
export function repairHuashengMaterialDescriptions(database, { apply = false, projectId } = {}) {
  const inspect = () => {
    const clips = database.prepare(`SELECT project_id,clip_id,selected_asset_id,selected_caption,metadata_json
      FROM huasheng_material_clips ${projectId === undefined ? '' : 'WHERE project_id=?'}`)
      .all(...(projectId === undefined ? [] : [String(projectId)]))
    const report = { apply, clipsScanned: clips.length, identitiesToRepair: 0, identitiesRepaired: 0,
      sourceCaptionsToRepair: 0, sourceCaptionsRepaired: 0, assetCaptionsToFill: 0, assetCaptionsFilled: 0,
      missingOriginalIdentity: 0, unverifiedCaption: 0, conflictingAssetCaptions: 0, knownAssetCaptionsPreserved: 0 }
    const captions = new Map()
    const link = apply ? database.prepare(`UPDATE huasheng_material_clips SET selected_asset_id=?,selected_caption=?
      WHERE project_id=? AND clip_id=?`) : null
    for (const clip of clips) {
      const video = originalVideo(clip.metadata_json)
      if (!video) { report.missingOriginalIdentity++; continue }
      // A legacy caption without a matching source identity cannot safely be reassigned.
      if (!video.caption && clip.selected_caption && clip.selected_asset_id !== video.id) {
        report.unverifiedCaption++; continue
      }
      const caption = video.caption || clip.selected_caption
      const identityChanged = clip.selected_asset_id !== video.id
      const captionChanged = clip.selected_caption !== caption
      if (identityChanged) report.identitiesToRepair++
      if (captionChanged) report.sourceCaptionsToRepair++
      if (apply && (identityChanged || captionChanged)) {
        link.run(video.id, caption, clip.project_id, clip.clip_id)
        if (identityChanged) report.identitiesRepaired++
        if (captionChanged) report.sourceCaptionsRepaired++
      }
      if (caption) {
        if (!captions.has(video.id)) captions.set(video.id, new Set())
        captions.get(video.id).add(caption)
      }
    }
    const asset = database.prepare('SELECT caption FROM huasheng_material_assets WHERE asset_id=?')
    const fill = apply ? database.prepare("UPDATE huasheng_material_assets SET caption=? WHERE asset_id=? AND caption=''") : null
    for (const [id, values] of captions) {
      const existing = asset.get(id)
      if (!existing) continue
      if (existing.caption) { report.knownAssetCaptionsPreserved++; continue }
      if (values.size !== 1) { report.conflictingAssetCaptions++; continue }
      report.assetCaptionsToFill++
      if (apply) report.assetCaptionsFilled += fill.run([...values][0], id).changes
    }
    return report
  }
  const transaction = database.transaction(inspect)
  return apply ? transaction.immediate() : transaction.deferred()
}
