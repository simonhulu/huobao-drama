import test from 'node:test'
import assert from 'node:assert/strict'
import {resolveHistoryASRConfig} from './history-asr-config.js'

const mini={provider:'minimax',baseUrl:'https://api.minimaxi.com',apiKey:'mini-key'}
const qwen={provider:'qwen-tts',baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1',apiKey:'qwen-key'}
const getConfig=(_type:'audio',provider?:string)=>provider==='minimax'?mini:qwen

test('ASR selects MiniMax independently of the higher-priority Qwen narration config',async()=>{
  const result=await resolveHistoryASRConfig({env:{},getConfig})
  assert.deepEqual(result,{provider:'minimax',baseUrl:'https://api.minimax.cn',apiKey:'mini-key'})
})
test('Qwen ASR reuses configured cloud credentials and preserves its regional endpoint',async()=>{
  const result=await resolveHistoryASRConfig({env:{},getConfig,provider:'qwen'})
  assert.deepEqual(result,{provider:'qwen',baseUrl:qwen.baseUrl,apiKey:'qwen-key'})
  assert.equal((await resolveHistoryASRConfig({env:{},getConfig:(_t,p)=>p==='minimax'?null:qwen})).provider,'qwen')
})
test('explicit environment selection is honored and invalid or incomplete configs are rejected',async()=>{
  const env={QWEN_API_KEY:'env-key',QWEN_ASR_BASE_URL:'https://dashscope-intl.aliyuncs.com/api/v1'}
  assert.deepEqual(await resolveHistoryASRConfig({env,getConfig:()=>assert.fail('Environment Qwen needs no database')}),{provider:'qwen',baseUrl:env.QWEN_ASR_BASE_URL,apiKey:'env-key'})
  assert.equal((await resolveHistoryASRConfig({env:{...env,ASR_PROVIDER:'minimax'},getConfig})).provider,'minimax')
  await assert.rejects(resolveHistoryASRConfig({env:{ASR_PROVIDER:'bad'},getConfig}),/ASR_PROVIDER/)
  await assert.rejects(resolveHistoryASRConfig({env:{ASR_PROVIDER:'qwen'},getConfig:()=>null}),/Qwen/)
  await assert.rejects(resolveHistoryASRConfig({env:{},getConfig:()=>null}),/MiniMax.*Qwen/)
  await assert.rejects(resolveHistoryASRConfig({env:{},getConfig:()=>({...mini,apiKey:'  '})}),/转写/)
})
