const BASE = '/api/v1'

async function req<T = any>(method: string, path: string, body?: any): Promise<T> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify(body)

  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path}`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', body || '')

  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const raw = await resp.text()
    let json: any = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = null
    }
    const ms = Math.round(performance.now() - start)

    if (!resp.ok || (json?.code && json.code >= 400)) {
      const message = json?.message || raw || `${resp.status}`
      console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', message)
      throw new Error(message)
    }

    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    return (json?.data ?? json) as T
  } catch (err: any) {
    if (!err.message?.match(/^\d{3}$/)) {
      const ms = Math.round(performance.now() - start)
      console.log(`%c[API] %c${method} ${path} %cERROR %c${ms}ms`, 'color:#888', 'color:#ef5350', 'color:#ef5350;font-weight:bold', 'color:#888', err.message)
    }
    throw err
  }
}

async function reqUpload<T = any>(method: string, path: string, body: FormData): Promise<T> {
  const opts: RequestInit = { method, body }
  const start = performance.now()
  console.log(`%c[API] %c${method} %c${path} %c<FormData>`, 'color:#888', 'color:#4fc3f7;font-weight:bold', 'color:#ccc', 'color:#888')
  try {
    const resp = await fetch(`${BASE}${path}`, opts)
    const raw = await resp.text()
    let json: any = null
    try { json = raw ? JSON.parse(raw) : null } catch {}
    const ms = Math.round(performance.now() - start)
    console.log(`%c[API] %c${method} ${path} %c${resp.status} %c${ms}ms`, 'color:#888', 'color:#66bb6a', 'color:#66bb6a;font-weight:bold', 'color:#888')
    if (!resp.ok || (json?.code && json.code >= 400)) {
      const message = json?.message || raw || `${resp.status}`
      throw new Error(message)
    }
    return (json?.data ?? json) as T
  } catch (err: any) {
    throw err
  }
}

export const api = {
  get: <T = any>(p: string) => req<T>('GET', p),
  post: <T = any>(p: string, b?: any) => req<T>('POST', p, b),
  put: <T = any>(p: string, b?: any) => req<T>('PUT', p, b),
  del: <T = any>(p: string) => req<T>('DELETE', p),
  upload: <T = any>(p: string, b: FormData) => reqUpload<T>('POST', p, b),
}

export const dramaAPI = {
  list: () => api.get<{ items: any[] }>('/dramas'),
  get: (id: number) => api.get(`/dramas/${id}`),
  create: (data: any) => api.post('/dramas', data),
  update: (id: number, data: any) => api.put(`/dramas/${id}`, data),
  del: (id: number) => api.del(`/dramas/${id}`),
  smartSplit: (id: number, data: any) => api.post(`/dramas/${id}/smart-split`, { style: 'default', ...data }),
  importScript: (id: number, data: any) => api.post(`/dramas/${id}/import-script`, data),
  preProduction: (id: number) => api.post(`/dramas/${id}/pre-production`, {}),
}

export const episodeAPI = {
  create: (data: any) => api.post('/episodes', data),
  update: (id: number, data: any) => api.put(`/episodes/${id}`, data),
  del: (id: number) => api.del(`/episodes/${id}`),
  bulkDelete: (ids: number[]) => api.post('/episodes/bulk-delete', { episode_ids: ids }),
  characters: (id: number) => api.get(`/episodes/${id}/characters`),
  scenes: (id: number) => api.get(`/episodes/${id}/scenes`),
  storyboards: (id: number) => api.get(`/episodes/${id}/storyboards`),
  pipelineStatus: (id: number) => api.get(`/episodes/${id}/pipeline-status`),
  generateNarrations: (id: number) => api.post(`/episodes/${id}/generate-narrations`),
}

export const storyboardAPI = {
  create: (data: any) => api.post('/storyboards', data),
  update: (id: number, data: any) => api.put(`/storyboards/${id}`, data),
  generateTTS: (id: number) => api.post(`/storyboards/${id}/generate-tts`),
  del: (id: number) => api.del(`/storyboards/${id}`),
  detectOverloads: (episodeId: number) => api.get(`/storyboards/overloads?episode_id=${episodeId}`),
  autoSplit: (episodeId: number, preview: boolean, shotIds?: number[]) =>
    api.post('/storyboards/auto-split', { episode_id: episodeId, preview, shot_ids: shotIds }),
}

export const characterAPI = {
  update: (id: number, data: any) => api.put(`/characters/${id}`, data),
  voiceSample: (id: number, episodeId: number) => api.post(`/characters/${id}/generate-voice-sample`, { episode_id: episodeId }),
  generateImage: (id: number, episodeId: number) => api.post(`/characters/${id}/generate-image`, { episode_id: episodeId }),
  batchImages: (ids: number[], episodeId: number) => api.post('/characters/batch-generate-images', { character_ids: ids, episode_id: episodeId }),
}

export const sceneAPI = {
  generateImage: (id: number, episodeId: number) => api.post(`/scenes/${id}/generate-image`, { episode_id: episodeId }),
}

export const imageAPI = {
  generate: (d: any) => api.post('/images', d),
  get: (id: number) => api.get(`/images/${id}`),
  list: (params?: { drama_id?: number; storyboard_id?: number }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.storyboard_id) query.set('storyboard_id', String(params.storyboard_id))
    return api.get(`/images${query.size ? `?${query.toString()}` : ''}`)
  },
}
export const gridAPI = {
  prompt: (d: any) => api.post('/grid/prompt', d),
  generate: (d: any) => api.post('/grid/generate', d),
  status: (id: number) => api.get(`/grid/status/${id}`),
  split: (d: any) => api.post('/grid/split', d),
}
export const videoAPI = {
  generate: (d: any) => api.post('/videos', d),
  get: (id: number) => api.get(`/videos/${id}`),
}
export const composeAPI = {
  shot: (id: number, force = false) => api.post(`/compose/storyboards/${id}/compose`, { force }),
  all: (epId: number, force = false) => api.post(`/compose/episodes/${epId}/compose-all`, { force }),
  status: (epId: number) => api.get(`/compose/episodes/${epId}/compose-status`),
  generateSubtitles: (epId: number) => api.post(`/compose/episodes/${epId}/subtitles`),
  subtitlePreview: (sbId: number) => api.post(`/compose/storyboards/${sbId}/subtitle-preview`),
}
export const ttsAPI = {
  shot: (id: number) => api.post(`/storyboards/${id}/generate-tts`),
  all: (epId: number, force = false) => api.post(`/episodes/${epId}/generate-tts-all`, { force }),
  narration: (epId: number, force = true) => api.post(`/episodes/${epId}/generate-narration-audio`, { force }),
}
export const mergeAPI = {
  merge: (epId: number) => api.post(`/merge/episodes/${epId}/merge`),
  status: (epId: number) => api.get(`/merge/episodes/${epId}/merge`),
}
export const taskAPI = {
  create: (d: any) => api.post('/tasks', d),
  list: (params?: { drama_id?: number; episode_id?: number; status?: string; type?: string }) => {
    const query = new URLSearchParams()
    if (params?.drama_id) query.set('drama_id', String(params.drama_id))
    if (params?.episode_id) query.set('episode_id', String(params.episode_id))
    if (params?.status) query.set('status', params.status)
    if (params?.type) query.set('type', params.type)
    return api.get(`/tasks${query.size ? `?${query.toString()}` : ''}`)
  },
  get: (id: number) => api.get(`/tasks/${id}`),
  events: (id: number) => api.get(`/tasks/${id}/events`),
  cancel: (id: number) => api.post(`/tasks/${id}/cancel`),
}
export const aiConfigAPI = {
  list: (t?: string) => api.get(`/ai-configs${t ? `?service_type=${t}` : ''}`),
  create: (d: any) => api.post('/ai-configs', d),
  update: (id: number, d: any) => api.put(`/ai-configs/${id}`, d),
  del: (id: number) => api.del(`/ai-configs/${id}`),
  test: (d: any) => api.post('/ai-configs/test', d),
  huobaoPreset: (apiKey: string) => api.post('/ai-configs/huobao-preset', { api_key: apiKey }),
  cloneVoice: (id: number, formData: FormData) => api.upload(`/ai-configs/${id}/clone-voice`, formData),
}

export const agentConfigAPI = {
  list: () => api.get('/agent-configs'),
  get: (id: number) => api.get(`/agent-configs/${id}`),
  create: (d: any) => api.post('/agent-configs', d),
  update: (id: number, d: any) => api.put(`/agent-configs/${id}`, d),
  del: (id: number) => api.del(`/agent-configs/${id}`),
}

export const scriptAPI = {
  clean: (content: string, options: any = {}) => api.post('/scripts/clean', { content, ...options }),
}

export const skillsAPI = {
  list: () => api.get('/skills'),
  get: (id: string) => api.get(`/skills/${id}`),
  create: (data: { id: string; name: string; description?: string }) => api.post('/skills', data),
  update: (id: string, content: string) => api.put(`/skills/${id}`, { content }),
  del: (id: string) => api.del(`/skills/${id}`),
}

export const voicesAPI = {
  list: (provider?: string) => api.get(`/ai-voices${provider ? `?provider=${provider}` : ''}`),
  sync: () => api.post('/ai-voices/sync', {}),
  autoAssign: (episodeId: number, overwrite = false) =>
    api.post('/characters/auto-assign-voices', { episode_id: episodeId, overwrite }),
  dedupePitches: (episodeId: number) =>
    api.post('/characters/dedupe-voice-pitches', { episode_id: episodeId }),
}

export const libraryAPI = {
  music: () => api.get<{ total: number; generated_at: string; items: any[] }>('/library/music'),
  sfx: () => api.get<{ total: number; mapping_exists: boolean; generated_at: string | null; items: any[] }>('/library/sfx'),
  refresh: () => api.post<{ total: number; generated_at: string }>('/library/refresh'),
  lookupMusic: (path: string) => api.get<any>(`/library/music/lookup?path=${encodeURIComponent(path)}`),
  lookupSfx: (path: string) => api.get<any>(`/library/sfx/lookup?path=${encodeURIComponent(path)}`),
  deleteMusic: (path: string) => api.del(`/library/music?path=${encodeURIComponent(path)}`),
  deleteSfx: (path: string) => api.del(`/library/sfx?path=${encodeURIComponent(path)}`),
}

export const healthAPI = {
  workers: () => api.get<{ healthy_count: number; total_count: number; timeout_ms: number; workers: any[] }>('/health/workers'),
  imageMetrics: () => api.get<{ total: number; pending: number; processing: number; completed: number; failed: number; completed_last_24h: number }>('/metrics/image-generation'),
}
