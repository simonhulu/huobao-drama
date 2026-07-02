/**
 * MiniMax Music / BGM 生成 Adapter
 *
 * 流程：
 * 1. POST /v1/music_generation 创建任务，返回 task_id
 * 2. GET /v1/query/music_generation?task_id=... 轮询到 Success/Fail
 * 3. GET /v1/files/retrieve?file_id=... 换取 download_url
 */
import type {
  AIConfig,
  MusicProviderAdapter,
  MusicGenerationRecord,
  MusicGenResponse,
  MusicPollResponse,
  ProviderRequest,
} from './types'
import { joinProviderUrl } from './url.js'

export class MiniMaxMusicAdapter implements MusicProviderAdapter {
  readonly provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: MusicGenerationRecord): ProviderRequest {
    const prompt = (record.prompt || '').trim()
    if (!prompt) {
      throw new Error('MiniMax Music prompt is empty')
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/music_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: {
        model: record.model || config.model || 'music-2.6',
        prompt,
        is_instrumental: true,
        audio_setting: {
          sample_rate: 44100,
          bitrate: 256000,
          format: 'mp3',
        },
        output_format: 'url',
      },
    }
  }

  parseGenerateResponse(result: any): MusicGenResponse {
    if (result?.base_resp?.status_code && result.base_resp.status_code !== 0) {
      return {
        isAsync: false,
        error: result.base_resp.status_msg || 'MiniMax Music generation failed',
      }
    }

    const taskId = result?.task_id || result?.data?.task_id || result?.id || result?.data?.id
    if (taskId) {
      return { isAsync: true, taskId: String(taskId) }
    }

    // 同步返回（output_format=url 时较少见，但做兼容；MiniMax 也可能放在 data.audio）
    const audioUrl = result?.audio_url || result?.data?.audio_url || result?.data?.audio || result?.file?.download_url
    if (audioUrl) {
      return { isAsync: false, audioUrl: String(audioUrl) }
    }

    return { isAsync: false, error: 'No task_id or audio_url in MiniMax Music response' }
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    const baseUrl = joinProviderUrl(config.baseUrl, '/v1', '/query/music_generation')
    return {
      url: `${baseUrl}?task_id=${encodeURIComponent(taskId)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parsePollResponse(result: any): MusicPollResponse {
    if (result?.base_resp?.status_code && result.base_resp.status_code !== 0) {
      return {
        status: 'failed',
        error: result.base_resp.status_msg || 'MiniMax Music poll failed',
      }
    }

    const status = result?.status || result?.data?.status
    const normalized = String(status || '').toLowerCase()

    if (normalized === 'success' || normalized === 'completed' || normalized === 'succeeded') {
      return {
        status: 'completed',
        fileId: result?.file_id || result?.data?.file_id,
        audioUrl: result?.audio_url || result?.data?.audio_url || result?.data?.audio,
      }
    }

    if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') {
      return {
        status: 'failed',
        error: result?.error_msg || result?.data?.error_msg || 'MiniMax Music generation failed',
      }
    }

    return { status: 'processing' }
  }

  buildFileRetrieveRequest(config: AIConfig, fileId: string): ProviderRequest {
    const baseUrl = joinProviderUrl(config.baseUrl, '/v1', '/files/retrieve')
    return {
      url: `${baseUrl}?file_id=${encodeURIComponent(fileId)}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: undefined,
    }
  }

  parseFileRetrieveResponse(result: any): { audioUrl: string | null; error?: string } {
    if (result?.base_resp?.status_code && result.base_resp.status_code !== 0) {
      return {
        audioUrl: null,
        error: result.base_resp.status_msg || 'MiniMax file retrieve failed',
      }
    }

    const audioUrl = result?.file?.download_url || result?.download_url || result?.data?.download_url || null
    return { audioUrl }
  }
}
