import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'narration-voice-default-'))
process.env.DB_PATH=path.join(directory,'test.db')
const {db,schema}=await import('../db/index.js')
const {resolveDefaultNarrationVoiceId,QWEN3_DEFAULT_VOICE_ID}=await import('./qwen3-voice.js')
const {DEFAULT_NARRATION_VOICE_ID}=await import('./narration-defaults.js')
const {eq}=await import('drizzle-orm')
test.after(()=>{db.$client.close();fs.rmSync(directory,{recursive:true,force:true})})

test('configured narration clone becomes the live default for its provider without changing legacy or Qwen voices',()=>{
  assert.equal(DEFAULT_NARRATION_VOICE_ID,'ttv-voice-2026072016135626-xnywYYL4')
  assert.equal(resolveDefaultNarrationVoiceId('minimax'),DEFAULT_NARRATION_VOICE_ID)
  const ts=new Date().toISOString()
  const id=Number(db.insert(schema.aiServiceConfigs).values({serviceType:'audio',provider:'minimax',name:'Narration fixture',
    baseUrl:'https://example.test',apiKey:'test-key',model:'["speech-2.8-hd"]',isActive:true,priority:10,
    settings:JSON.stringify({useForNarration:true,narrationVoiceId:'NewHistoryVoice01'}),createdAt:ts,updatedAt:ts}).run().lastInsertRowid)
  assert.equal(resolveDefaultNarrationVoiceId('minimax'),'NewHistoryVoice01')
  assert.equal(resolveDefaultNarrationVoiceId(),'NewHistoryVoice01')
  assert.equal(resolveDefaultNarrationVoiceId('other-provider'),DEFAULT_NARRATION_VOICE_ID)
  assert.equal(resolveDefaultNarrationVoiceId('qwen3-tts'),QWEN3_DEFAULT_VOICE_ID)
  db.update(schema.aiServiceConfigs).set({settings:JSON.stringify({useForNarration:true,narrationVoiceId:'NextHistoryVoice02'})}).where(eq(schema.aiServiceConfigs.id,id)).run()
  assert.equal(resolveDefaultNarrationVoiceId('minimax'),'NextHistoryVoice02','configuration changes are read without caching the old voice')
  db.update(schema.aiServiceConfigs).set({isActive:false}).where(eq(schema.aiServiceConfigs.id,id)).run()
  assert.equal(resolveDefaultNarrationVoiceId('minimax'),DEFAULT_NARRATION_VOICE_ID)
})
