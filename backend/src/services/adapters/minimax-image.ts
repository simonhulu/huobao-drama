/**
 * MiniMax 图片生成 Adapter
 * API 风格与 OpenAI 兼容，零改动
 */
import type {
  ImageProviderAdapter,
  ProviderRequest,
  AIConfig,
  ImageGenerationRecord,
  ImageGenResponse,
  ImagePollResponse,
} from './types'
import { joinProviderUrl } from './url.js'
import { sizeToMiniMaxAspectRatio } from './minimax-aspect-ratio.js'
import { normalizePrompt } from './prompt-utils.js'

export class MiniMaxImageAdapter implements ImageProviderAdapter {
  provider = 'minimax'

  buildGenerateRequest(config: AIConfig, record: ImageGenerationRecord): ProviderRequest {
    // MiniMax 文生图是同步接口，使用 aspect_ratio 而非 size
    // 支持的 aspect_ratio: 1:1, 16:9, 4:3, 3:2, 2:3, 3:4, 9:16, 21:9
    const aspectRatio = sizeToMiniMaxAspectRatio(record.size)

    const body: any = {
      model: record.model || config.model,
      prompt: normalizePrompt(record.prompt, this.provider),
      aspect_ratio: aspectRatio,
      n: 1,
      response_format: 'url',
    }

    if (record.seed != null) {
      body.seed = record.seed
    }

    // MiniMax 图生图人物一致性：通过 subject_reference 传入角色参考图
    if (record.referenceImages) {
      try {
        const refs = JSON.parse(record.referenceImages)
        if (Array.isArray(refs) && refs.length > 0) {
          body.subject_reference = refs.slice(0, 9).map((imageFile: string) => ({
            type: 'character',
            image_file: imageFile,
          }))
        }
      } catch {}
    }

    return {
      url: joinProviderUrl(config.baseUrl, '/v1', '/image_generation'),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body,
    }
  }

  parseGenerateResponse(result: any): ImageGenResponse {
    // MiniMax 文生图同步返回 { data: { image_urls: [...] } }
    const imageUrls = result.data?.image_urls
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      return { isAsync: false, imageUrl: imageUrls[0] }
    }
    throw new Error('No image URL in MiniMax response')
  }

  buildPollRequest(): ProviderRequest {
    // MiniMax 文生图没有轮询接口
    throw new Error('MiniMax image generation does not support polling')
  }

  parsePollResponse(): ImagePollResponse {
    // MiniMax 文生图没有轮询接口
    throw new Error('MiniMax image generation does not support polling')
  }

  extractImageUrl(result: any): string | null {
    const imageUrls = result.data?.image_urls
    if (Array.isArray(imageUrls) && imageUrls.length > 0) {
      return imageUrls[0]
    }
    return null
  }

  extractImageBase64(result: any): { data: string; mimeType: string } | null {
    // MiniMax 文生图只返回 URL
    return null
  }
}
