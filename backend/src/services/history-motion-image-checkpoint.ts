import {classifyImageError,getUserMessageZh} from '../utils/error-taxonomy.js'

export interface MotionImageCheckpoint {
  id: number
  configId?: number
  submitted: boolean
  submissionAttempts?: number
}

export interface MotionImageRecord {
  status: string | null
  task_id?: string | null
  local_path?: string | null
  provider?: string | null
  model?: string | null
  error_msg?: string | null
  last_error_code?: string | null
}

export interface MotionImageConfig {
  id: number
  provider: string | null
  model: string | null
  priority: number | null
}

function motionImageRetryReason(record: MotionImageRecord) {
  if (record.status !== 'failed' || record.task_id) return undefined
  const message=record.error_msg || ''
  if (/^API error 429\b/.test(message)) return 'rate_limited'
  const response=/^API error (502|503):\s*(.*)$/s.exec(message)
  if (!response) return undefined
  try {
    const body=JSON.parse(response[2]!)
    const hasTaskFields=(value:unknown)=>value && typeof value==='object' &&
      Object.keys(value).some(key=>/^(?:id|task_?id|task|data)$/i.test(key))
    if(hasTaskFields(body) || hasTaskFields(body.error))return undefined
    // Gateways use several messages for the same transient upstream failure,
    // including "Upstream request failed". Without a provider task id these
    // responses are safe to submit again.
    if(body.error?.type === 'upstream_error')return 'upstream_unavailable'
    if(response[1]==='503' && body.error?.type === 'api_error' && /^No available compatible accounts\.?$/i.test(body.error?.message || ''))return 'capacity_unavailable'
  } catch { /* A malformed gateway response does not prove rejection. */ }
  return undefined
}

export function isRetryableMotionImageRejection(record: MotionImageRecord) {
  return motionImageRetryReason(record)!==undefined
}

export function motionImageRejectionError(record: MotionImageRecord) {
  if (record.status !== 'failed') return undefined
  const message=record.error_msg || ''
  if (record.last_error_code === 'content_policy_violation' || /\b(?:content_policy_violation|moderation_blocked)\b/i.test(message)) {
    return Object.assign(Error('图片服务明确拒绝了当前画面内容，需要调整场景表达后补图'),{code:'content_policy_violation'})
  }
  if(motionImageRetryReason(record)==='capacity_unavailable') {
    return Object.assign(Error('图片服务暂时没有可用的兼容账号，有限重试后仍繁忙；已保留请求和完成素材，可稍后重试当前步骤'),{code:'image_provider_capacity'})
  }
  const status=/^API error (4\d\d)\b/.exec(message)?.[1]
  // 408 does not establish whether work was accepted; 429 keeps its existing retry path.
  if (!status || status === '408' || status === '429') return undefined
  const classification=classifyImageError(Error(message))
  const code=record.last_error_code && record.last_error_code !== 'unknown_error'
    ? record.last_error_code : classification.code === 'unknown_error' ? 'bad_request' : classification.code
  return Object.assign(Error(`图片服务拒绝了请求（HTTP ${status}）：${getUserMessageZh(code)}`),{code})
}

export function motionImageRecoveryAction(saved: MotionImageCheckpoint, record: MotionImageRecord) {
  if (record.status === 'completed') return 'completed'
  // A live provider task can be polled. Once the provider has marked it
  // failed, the old task is no longer useful to this production attempt;
  // resubmit it. The worker clears the stale task id before that request.
  if (record.task_id && record.status !== 'failed') return 'resume'
  if (record.task_id && record.status === 'failed') {
    const rejection=motionImageRejectionError(record)
    if (rejection) throw rejection
    return 'submit'
  }
  if (!saved.submitted) return 'submit'
  // An explicit rejection created no task and must not be blindly replayed.
  if (isRetryableMotionImageRejection(record)) return 'submit'
  const rejection=motionImageRejectionError(record)
  if (rejection) throw rejection
  // A request without a provider task id cannot be polled or recovered. Let
  // the next run submit the same shot again; otherwise one lost gateway
  // response would permanently block the whole episode.
  return 'submit'
}

export function resolveMotionImageConfigId(
  configs: MotionImageConfig[], saved?: MotionImageCheckpoint, record?: MotionImageRecord,
) {
  if (saved?.configId != null) {
    if (!configs.some(config => config.id === saved.configId)) throw Error('原图片服务配置已停用，保留原请求记录')
    return saved.configId
  }
  if (saved) {
    // Older checkpoints omitted configId. Recover only an unambiguous matching
    // provider/model; never send an existing task to a different provider.
    const matches = configs.filter(config => {
      let models: unknown
      try { models = JSON.parse(config.model || '[]') } catch { return false }
      return config.provider === record?.provider && Array.isArray(models) && models.includes(record?.model)
    })
    if (matches.length !== 1) throw Error('无法唯一恢复原图片服务配置，保留原请求记录')
    return matches[0]!.id
  }
  const active = [...configs].sort((a, b) => (b.priority || 0) - (a.priority || 0))[0]
  if (!active) throw Error('未配置可用的图片生成服务')
  return active.id
}

