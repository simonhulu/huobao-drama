import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DEFAULT_HISTORY_YOUTUBE_URL, parseHistoryYoutubeUrl } from './history-source-youtube-url.js'

export const historySourceKeywordsSchema = z.array(z.string().trim().min(1).max(80)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), '关键词不能包含换行或控制字符'))
  .min(1).max(30).refine(values => new Set(values).size === values.length, '关键词不能重复')
export const historyYoutubeSourceUrlSchema = z.string().trim().min(1).max(2048).transform((value, ctx) => {
  try { return parseHistoryYoutubeUrl(value).url }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER }
})
function channelIdentity(url: string) {
  const parsed = new URL(url), path = decodeURI(parsed.pathname).normalize('NFC')
  return path.startsWith('/@') ? path.toLowerCase() : path + parsed.search
}
export const historyYoutubeChannelsSchema = z.array(historyYoutubeSourceUrlSchema.refine(value => parseHistoryYoutubeUrl(value).kind === 'channel', '频道列表只接受频道链接，单条视频请使用单视频采集'))
  .min(1).max(30).refine(values => new Set(values.map(channelIdentity)).size === values.length, 'YouTube 频道不能重复')
export const historyYoutubeSourceUrlsSchema = z.array(historyYoutubeSourceUrlSchema).min(1).max(30)
  .refine(values => new Set(values.map(channelIdentity)).size === values.length, 'YouTube 来源不能重复')
export const historySourceSettingsSchema = z.object({ keywords: historySourceKeywordsSchema,
  youtubeChannels: historyYoutubeChannelsSchema.prefault([DEFAULT_HISTORY_YOUTUBE_URL]),
}).strict()
const settingsUpdateSchema = z.object({ keywords: historySourceKeywordsSchema.optional(), youtubeChannels: historyYoutubeChannelsSchema.optional() }).strict()
  .refine(value => value.keywords !== undefined || value.youtubeChannels !== undefined, '请提交关键词或 YouTube 频道列表')
export type HistorySourceSettings = z.infer<typeof historySourceSettingsSchema>

function settingsFile() {
  const database = process.env.DB_PATH || resolve(dirname(fileURLToPath(import.meta.url)), '../../../data/huobao_drama.db')
  return process.env.HISTORY_SOURCE_SETTINGS_FILE || `${database}.history-source-settings.json`
}

export function readHistorySourceSettings(file = settingsFile()): HistorySourceSettings {
  try { return historySourceSettingsSchema.parse(JSON.parse(readFileSync(file, 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return historySourceSettingsSchema.parse({ keywords: ['历史'] })
    throw new Error('采集设置读取失败，请检查设置文件后重试', { cause: error })
  }
}

export function writeHistorySourceSettings(input: unknown, file = settingsFile()): HistorySourceSettings {
  const patch = settingsUpdateSchema.parse(input)
  const settings = historySourceSettingsSchema.parse({ ...readHistorySourceSettings(file), ...patch })
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(settings, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } finally {
    try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return settings
}
