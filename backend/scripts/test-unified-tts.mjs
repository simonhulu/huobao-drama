import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const API_KEY = process.env.MINIMAX_API_KEY

if (!API_KEY) {
  throw new Error('MINIMAX_API_KEY is required')
}

const text = `萬曆34年3月，已經多年不上朝的萬曆皇帝在看到一份奏報之後，被氣得去不下飯。這份奏報是從雲南送來的，裡面說雲南發生了一場民變，發生衝突的兩方都是朝廷的官員。殺人的賀士勳是明朝正三品的五官，被殺的楊榮是萬曆皇帝派到雲南的礦稅太監。這起事件其實是明朝晚期礦稅之弊的一個縮影。萬曆年間，各地反對礦稅的鬥爭此起彼伏，從未停止。萬曆26年，山東臨清爆發了一場浩大的民變。`

async function main() {
  const createResp = await fetch('https://api.minimaxi.com/v1/t2a_async_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'speech-2.8-hd',
      text,
      language_boost: 'auto',
      voice_setting: { voice_id: 'DaniangzhuVoice01', speed: 1.2, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
      subtitle_enable: true,
      subtitle_type: 'sentence',
    }),
  })
  const createData = await createResp.json()
  console.log('create', JSON.stringify(createData, null, 2))
  const taskId = createData.task_id
  const fileId = createData.file_id

  // poll
  let status = 'Processing'
  while (status === 'Processing') {
    await new Promise(r => setTimeout(r, 3000))
    const q = await fetch(`https://api.minimaxi.com/v1/query/t2a_async_query_v2?task_id=${taskId}`, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    })
    const qd = await q.json()
    console.log('poll', qd.status)
    status = qd.status
  }
  if (status !== 'Success') throw new Error('failed ' + status)

  const ret = await fetch(`https://api.minimaxi.com/v1/files/retrieve?file_id=${fileId}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  })
  const retData = await ret.json()
  console.log('retrieve', JSON.stringify(retData, null, 2))
  const url = retData.file.download_url
  const bin = await fetch(url).then(r => r.arrayBuffer())
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-tts-'))
  const tarPath = path.join(tmp, 'out.tar.gz')
  fs.writeFileSync(tarPath, Buffer.from(bin))
  await execFileAsync('tar', ['-xzf', tarPath, '-C', tmp])
  console.log('extracted files:', fs.readdirSync(tmp, { recursive: true }))
  const titlesPath = fs.readdirSync(tmp, { recursive: true }).find(f => String(f).endsWith('.titles'))
  if (titlesPath) {
    console.log('titles content:')
    console.log(fs.readFileSync(path.join(tmp, titlesPath), 'utf8'))
  }
}

main().catch(e => { console.error(e); process.exit(1) })
