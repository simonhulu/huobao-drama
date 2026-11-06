import {QWEN_ASR_BASE_URL} from './adapters/qwen-asr.js'

export type HistoryASRProvider='minimax'|'qwen'
export interface HistoryASRConfig {provider:HistoryASRProvider;baseUrl:string;apiKey:string}
type AudioConfig={provider:string;baseUrl?:string;apiKey:string}
interface ConfigOptions {
  env?:NodeJS.ProcessEnv
  provider?:HistoryASRProvider
  getConfig?:(type:'audio',provider?:string)=>AudioConfig|null
}

/** Transcription capability is independent of the selected narration voice. */
export async function resolveHistoryASRConfig(options:ConfigOptions={}):Promise<HistoryASRConfig> {
  const env=options.env ?? process.env
  const explicit=options.provider || env.ASR_PROVIDER?.trim().toLowerCase()
  if(explicit && explicit!=='qwen' && explicit!=='minimax')throw Error('ASR_PROVIDER must be qwen or minimax')
  const preferred:HistoryASRProvider=explicit==='qwen'||explicit==='minimax'?explicit:(env.QWEN_API_KEY?.trim()?'qwen':'minimax')
  async function configured(provider:HistoryASRProvider):Promise<HistoryASRConfig|null> {
    if(provider==='qwen' && env.QWEN_API_KEY?.trim())return {provider,apiKey:env.QWEN_API_KEY.trim(),baseUrl:env.QWEN_ASR_BASE_URL?.trim() || QWEN_ASR_BASE_URL}
    const getConfig=options.getConfig ?? (await import('./ai.js')).getActiveConfig
    const name=provider==='qwen'?'qwen-tts':'minimax',config=getConfig('audio',name)
    if(config?.provider.trim().toLowerCase()!==name || !config.apiKey.trim())return null
    const supplied=config.baseUrl?.trim() || (provider==='qwen'?QWEN_ASR_BASE_URL:'https://api.minimax.cn')
    const endpoint=new URL(supplied)
    if(!['https:','http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password)throw Error('转写服务地址无效')
    const baseUrl=provider==='qwen'?(env.QWEN_ASR_BASE_URL?.trim() || supplied):
      (env.HISTORY_MINIMAX_ASR_BASE_URL?.trim() || (endpoint.hostname==='api.minimaxi.com'?'https://api.minimax.cn':supplied))
    return {provider,baseUrl,apiKey:config.apiKey.trim()}
  }
  const config=await configured(preferred)
  if(config)return config
  if(!explicit) {
    const alternate=await configured(preferred==='minimax'?'qwen':'minimax')
    if(alternate)return alternate
  }
  throw Error(explicit==='qwen'?'请配置 Qwen 云端音频服务或 QWEN_API_KEY，采集需要语音转写服务':
    explicit==='minimax'?'请配置已启用且带密钥的 MiniMax 转写服务':
    '请配置语音转写服务：启用带密钥的 MiniMax 或 Qwen 云端音频服务')
}
