function metadataRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function sourceId(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export function historyEpisodePublicationUrl(episodeMetadata: unknown, dramaMetadata?: unknown): string {
  const metadata = metadataRecord(episodeMetadata)
  const factory = metadata.historyFactory ?? metadata.history_factory
  const linkedFactory = factory && typeof factory === 'object' && !Array.isArray(factory)
  const id = sourceId(linkedFactory ? (factory as Record<string, unknown>).sourceId : null)
    ?? sourceId(metadataRecord(dramaMetadata).historySourceId)
  if (!id && !linkedFactory && factory !== 'remotion-history-factory') return ''
  return `/history-scripts?view=uploads${id ? `&script=${id}` : ''}`
}
