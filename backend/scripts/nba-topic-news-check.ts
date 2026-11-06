import fs from 'node:fs/promises'
import path from 'node:path'
import { collectNbaNews } from '../src/services/nba-news.js'
import type { NbaJob, NbaTopic } from '../src/services/nba-types.js'

const root = path.resolve('..'), output = path.resolve(process.env.NBA_TOPIC_CHECK_OUTPUT || path.join(root,'outputs/nba-sports-topic-validation'))
const snapshot = JSON.parse(await fs.readFile(path.join(root,'data/nba-video/collections/nba-run-511db8b1-7c9f-4687-9c3f-59c4a6aff6f4/rhZ6oVlNZHs.metadata.json'),'utf8'))
const metadata = snapshot.metadata
const topic:NbaTopic = {id:`youtube-${metadata.id}`,videoId:metadata.id,title:metadata.title,description:metadata.description,
  youtubeUrl:`https://www.youtube.com/watch?v=${metadata.id}`,channel:snapshot.channel,uploadDate:metadata.upload_date}
const result = await collectNbaNews({topic,languages:['en','zh'],limit:4,articleUrls:[],signal:AbortSignal.timeout(180000),
  progress:message => console.log(message)})
await fs.mkdir(output,{recursive:true})
await fs.writeFile(path.join(output,'retrieval.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify({articles:result.articles.map(row => ({title:row.title,language:row.language,wordCount:row.wordCount,characterCount:row.characterCount,url:row.url,hasGame:!!row.game,heldReason:row.heldReason})),sources:result.sources.filter(row => row.status !== 'ok')},null,2))
const article = result.articles.find(row => row.language === 'en')
if (!article) throw Error('真实检索尚未取得英文完整原稿')
article.game = undefined
const now = new Date().toISOString()
const job:NbaJob = {id:'nba-sports-topic-validation',title:article.title,article,status:'queued',stage:'intake',message:'体育主题原稿验证',createdAt:now,updatedAt:now,attempts:0,canResume:true,logs:[]}
await fs.writeFile(path.join(output,'source-job.json'),JSON.stringify(job,null,2))
console.log(path.join(output,'source-job.json'))
