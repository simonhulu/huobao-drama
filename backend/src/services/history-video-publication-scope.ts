export interface HistoryExecutionScope {
  sourceIds?: readonly number[]
  videoIds?: readonly number[]
  /** Publication pass: intent IDs. Social drain: upload job IDs. */
  jobIds?: readonly (number | string)[]
}

export function historyAutomationSourceIds(environment: NodeJS.ProcessEnv = process.env): number[] | undefined {
  const value = environment.HISTORY_AUTOMATION_SOURCE_IDS
  if (value === undefined) return undefined
  let ids: unknown
  try { ids = JSON.parse(value) } catch { throw Error('HISTORY_AUTOMATION_SOURCE_IDS must be a JSON array of source IDs') }
  if(!Array.isArray(ids) || ids.length>100)throw Error('HISTORY_AUTOMATION_SOURCE_IDS must contain at most 100 source IDs')
  historyExecutionScope({sourceIds: ids as number[]})
  return [...new Set(ids as number[])].sort((a, b) => a - b)
}

export function historyExecutionScope(scope?: HistoryExecutionScope) {
  if (scope === undefined) return {clause: '', values: [] as number[], key: 'global', scoped: false}
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).some(key => !['sourceIds', 'videoIds', 'jobIds'].includes(key))) throw Error('Invalid history execution allowlist')
  const clauses: string[] = [], values: number[] = []
  const normalized: Record<string, number[]> = {}
  for (const [key, column] of [['sourceIds', 'source_id'], ['videoIds', 'video_id'], ['jobIds', 'id']] as const) {
    const input = scope[key]
    if (input === undefined) continue
    if (!Array.isArray(input) || input.length > 1000) throw Error('Invalid history execution allowlist')
    const ids = [...new Set(input.map(value => {
      const id = key === 'jobIds' && typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw Error('Invalid history execution allowlist ID')
      return id
    }))].sort((a, b) => a - b)
    normalized[key] = ids
    clauses.push(ids.length ? `${column} IN (${ids.map(() => '?').join(',')})` : '0')
    values.push(...ids)
  }
  if (!clauses.length) throw Error('An explicit history execution allowlist cannot be empty; use an empty ID list to select nothing')
  return {clause: ` AND ${clauses.join(' AND ')}`, values, key: JSON.stringify(normalized), scoped: true}
}
