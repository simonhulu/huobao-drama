import path from 'path'
import fs from 'fs'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { applyVisualStyle } from '/Users/zhangshijie/Documents/workspace/huobao-drama/backend/src/services/visual-style.js'
import { getActiveConfig } from '/Users/zhangshijie/Documents/workspace/huobao-drama/backend/src/services/ai.js'

const repoRoot = '/Users/zhangshijie/Documents/workspace/huobao-drama'
const outputDir = path.join(repoRoot, 'data/temp/style-chart')
const baseScene = `A still life on an old wooden table: a cracked ceramic vase, an ancient scroll, a single plum blossom branch, and a bronze incense burner. Soft morning window light, shallow depth of field, no text, no watermark.`

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }
async function fetchWithProxy(url: string, init: any) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  const agent = proxy ? new ProxyAgent(proxy) : undefined
  return undiciFetch(url, { ...init, dispatcher: agent })
}
async function submitTask(config: any, prompt: string) {
  const url = `${config.baseUrl}/v1/images/generations`
  const resp = await fetchWithProxy(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model || 'gpt-image-2', prompt, size: '1:1', resolution: '1k', n: 1 }),
  })
  const text = await resp.text()
  if (!resp.ok) throw new Error(`Submit failed: ${resp.status} ${text}`)
  const data = JSON.parse(text)
  return data.data?.[0]?.task_id || data.task_id
}
async function pollTask(config: any, taskId: string): Promise<string> {
  const url = `${config.baseUrl}/v1/tasks/${taskId}`
  for (let i = 0; i < 120; i++) {
    await sleep(5000)
    const resp = await fetchWithProxy(url, { method: 'GET', headers: { Authorization: `Bearer ${config.apiKey}` } })
    const text = await resp.text()
    if (!resp.ok) continue
    const data = JSON.parse(text).data
    const status = String(data.status || '').toLowerCase()
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const url = data.result?.images?.[0]?.url
      return Array.isArray(url) ? url[0] : url
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') throw new Error(`Task failed: ${JSON.stringify(data.error || data)}`)
  }
  throw new Error('Polling timeout')
}
async function downloadImage(imageUrl: string, destPath: string) {
  const resp = await fetchWithProxy(imageUrl, { method: 'GET' })
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`)
  fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()))
}
async function main() {
  const config = getActiveConfig('image')
  const prompt = applyVisualStyle(baseScene, 'watercolor')
  console.log('prompt:', prompt.slice(0, 80))
  const taskId = await submitTask(config, prompt)
  console.log('taskId:', taskId)
  const imageUrl = await pollTask(config, taskId)
  const ext = path.extname(new URL(imageUrl).pathname) || '.png'
  const dest = path.join(outputDir, `watercolor${ext}`)
  await downloadImage(imageUrl, dest)
  console.log('saved ->', dest)
}
main().catch(e => { console.error(e); process.exit(1) })
