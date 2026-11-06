import test from 'node:test'
import assert from 'node:assert/strict'
import {motionImageRecoveryAction,motionImageRejectionError,resolveMotionImageConfigId, type MotionImageRecord} from './history-motion-image-checkpoint.js'

const configs=[{id:95,provider:'gpt-image2',model:'["gpt-image-2.5-flare"]',priority:330}]
const saved={id:25412,submitted:true}
const record={status:'failed',task_id:null,provider:'gpt-image2',model:'gpt-image-2.5-flare',error_msg:'API error 429: concurrency limit'}

test('legacy rate-limited checkpoint recovers the original config id and retries the existing record',()=>{
  assert.equal(resolveMotionImageConfigId(configs,saved,record),95)
  assert.equal(motionImageRecoveryAction(saved,record),'submit')
  assert.equal(resolveMotionImageConfigId(configs),95)
})

test('temporary and ambiguous upstream rejections can submit again when no task id was saved',()=>{
  for(const status of [502,503]) {
    assert.equal(motionImageRecoveryAction(saved,{...record,error_msg:`API error ${status}: {"error":{"type":"upstream_error","message":"Upstream service temporarily unavailable"}}`}),'submit')
    assert.equal(motionImageRecoveryAction(saved,{...record,error_msg:`API error ${status}: {"error":{"type":"upstream_error","message":"Upstream request failed"}}`}),'submit')
  }
  for(const message of [
    'API error 502: Bad Gateway',
    'API error 504: {"error":{"type":"upstream_error","message":"Upstream service temporarily unavailable"}}',
    'API error 502: {"error":{"type":"upstream_error","message":"Request timed out"}}',
    'API error 502: {"error":{"type":"upstream_error","message":"Upstream service temporarily unavailable"},"task_id":"existing-task"}',
  ]) assert.equal(motionImageRecoveryAction(saved,{...record,error_msg:message}),'submit')
})

test('explicit compatible-account capacity rejection retries and unknown 503 responses can submit again',()=>{
  const capacity={...record,error_msg:'API error 503: {"error":{"message":"No available compatible accounts","type":"api_error"}}'}
  assert.equal(motionImageRecoveryAction(saved,capacity),'submit')
  const error=motionImageRejectionError(capacity)
  assert.match(error!.message,/暂时没有可用的兼容账号/)
  assert.doesNotMatch(error!.message,/\{|api_error/)
  assert.equal((error as Error & {code:string}).code,'image_provider_capacity')
  for(const message of [
    'API error 503: Service Unavailable',
    'API error 503: {"error":{"message":"No available compatible accounts","type":"unknown_error"}}',
    'API error 503: {"error":{"message":"Request timed out","type":"api_error"}}',
    'API error 503: {"taskId":"existing","error":{"message":"No available compatible accounts","type":"api_error"}}',
    'API error 503: {"error":{"task_id":"existing","message":"No available compatible accounts","type":"api_error"}}',
  ]) assert.equal(motionImageRecoveryAction(saved,{...record,error_msg:message}),'submit')
  assert.equal(motionImageRecoveryAction(saved,{...capacity,task_id:'existing'}),'submit')
})

test('unknown submissions can be retried while explicit rejection still blocks',()=>{
  const states: MotionImageRecord[] = [
    {...record,status:'processing'},
    {...record,error_msg:'Request timed out'},
    {...record,error_msg:'No image URL or base64 data in response'},
    {...record,error_msg:'API error 408: request timed out'},
    {...record,status:'failed',last_error_code:'content_policy_violation',error_msg:'API error 400: moderation_blocked'},
  ]
  for(const state of states) {
    if (state.last_error_code === 'content_policy_violation') assert.throws(() => motionImageRecoveryAction(saved,state))
    else assert.equal(motionImageRecoveryAction(saved,state),'submit')
  }
})

test('confirmed content rejections retain a readable reason and structured code without resubmitting',()=>{
  for(const rejected of [
    {...record,last_error_code:'content_policy_violation',error_msg:'provider rejected the prompt'},
    {...record,error_msg:'API error 400: {"error":{"code":"moderation_blocked"}}'},
    {...record,error_msg:'API error 400: content_policy_violation'},
    {...record,error_msg:'API error 400: rejected by the safety system'},
  ]) assert.throws(()=>motionImageRecoveryAction(saved,rejected),error=>{
    assert.equal((error as Error & {code:string}).code,'content_policy_violation')
    assert.match((error as Error).message,/拒绝/)
    assert.doesNotMatch((error as Error).message,/结果不明/)
    return true
  })
})

test('other explicit client rejections are surfaced without automatic resubmission',()=>{
  for(const [status,code] of [[400,'bad_request'],[401,'auth_failed'],[402,'payment_required'],[403,'auth_failed'],[404,'not_found'],[422,'bad_request']] as const) {
    assert.throws(()=>motionImageRecoveryAction(saved,{...record,error_msg:`API error ${status}: rejected`,last_error_code:'unknown_error'}),error=>{
      assert.equal((error as Error & {code:string}).code,code)
      assert.match((error as Error).message,new RegExp(`HTTP ${status}`))
      return true
    })
  }
})

test('a live provider task resumes, while a failed or expired task is resubmitted',()=>{
  assert.equal(motionImageRecoveryAction(saved,{...record,status:'processing',task_id:'provider-task'}),'resume')
  assert.equal(motionImageRecoveryAction(saved,{...record,status:'failed',task_id:'provider-task'}),'submit')
  assert.throws(() => motionImageRecoveryAction(saved,{...record,status:'failed',task_id:'provider-task',last_error_code:'content_policy_violation'}),/拒绝/)
  assert.equal(motionImageRecoveryAction(saved,{...record,status:'completed',local_path:'cached.png'}),'completed')
  assert.equal(motionImageRecoveryAction(saved,{...record,status:'completed',local_path:'cached.png',last_error_code:'content_policy_violation'}),'completed')
  assert.equal(motionImageRecoveryAction({...saved,submitted:false},{...record,status:'processing'}),'submit')
})

test('old checkpoints cannot silently switch providers or choose between ambiguous matching configs',()=>{
  assert.throws(()=>resolveMotionImageConfigId([],saved,record),/无法唯一恢复/)
  assert.throws(()=>resolveMotionImageConfigId([...configs,{...configs[0]!,id:96}],saved,record),/无法唯一恢复/)
  assert.throws(()=>resolveMotionImageConfigId(configs,{...saved,configId:94},record),/已停用/)
  assert.equal(resolveMotionImageConfigId(configs,{...saved,configId:95},record),95)
})
