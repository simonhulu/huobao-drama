#!/usr/bin/env node
import puppeteer from 'puppeteer-core'

const CDP_URL = process.env.WECHAT_CHANNELS_CDP_URL || 'http://127.0.0.1:9222'
const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
const pages = await browser.pages()
let page = pages.find(p => p.url().includes('channels.weixin.qq.com/platform/post/create'))
if (!page) page = pages.find(p => p.url().includes('channels.weixin.qq.com'))
if (!page) page = pages[0]

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Replicate handler's collectAllElements
function collectAllElements(root) {
  const base = root ?? globalThis.document
  const result = []
  const nodes = base.querySelectorAll('*')
  for (const el of nodes) {
    result.push(el)
    if (el.shadowRoot) {
      result.push(...collectAllElements(el.shadowRoot))
    }
  }
  return result
}

for (let i = 0; i < 5; i++) {
  const url = page.url()
  const bodyText = await page.evaluate(() => document.body?.textContent?.slice(0, 200) || '').catch(() => '')

  const initializing = await page.evaluate(() => {
    const all = collectAllElements()
    return all.some(el => /页面初始化中|加载中/.test(el.textContent || '')) ||
      document.querySelector('[class*="loading"]') !== null
  }).catch(err => `error: ${err.message}`)

  const hasUploadTrigger = await page.evaluate(() => {
    const all = collectAllElements()
    const hasInput = all.some(el => el.tagName === 'INPUT' && el.type === 'file' && /video/.test(el.accept || ''))
    const hasArea = all.some(el => /上传时长|大小不超过|分辨率720p|MP4\/H\.264/.test(el.textContent || ''))
    return { hasInput, hasArea }
  }).catch(err => `error: ${err.message}`)

  const uploadTextSamples = await page.evaluate(() => {
    const all = collectAllElements()
    return all
      .filter(el => /上传时长|大小不超过|分辨率720p|MP4/.test(el.textContent || ''))
      .slice(0, 5)
      .map(el => ({
        text: (el.textContent || '').trim().slice(0, 100),
        tag: el.tagName,
        class: (el.className || '').slice(0, 50),
      }))
  }).catch(err => [])

  const loadingElements = await page.evaluate(() => {
    const all = collectAllElements()
    return all
      .filter(el => /页面初始化中|加载中/.test(el.textContent || '') || (el.className || '').includes('loading'))
      .slice(0, 5)
      .map(el => ({
        text: (el.textContent || '').trim().slice(0, 50),
        tag: el.tagName,
        class: (el.className || '').slice(0, 50),
        visible: el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0,
      }))
  }).catch(err => [])

  console.log(`check ${i + 1}: url=${url}`)
  console.log('  initializing:', initializing)
  console.log('  hasUploadTrigger:', JSON.stringify(hasUploadTrigger))
  console.log('  uploadTextSamples:', JSON.stringify(uploadTextSamples))
  console.log('  loadingElements:', JSON.stringify(loadingElements))
  console.log('  bodyText:', bodyText.slice(0, 100))

  if (url.includes('/platform/post/create') && !initializing && hasUploadTrigger && (hasUploadTrigger.hasInput || hasUploadTrigger.hasArea)) {
    console.log('PAGE READY')
    break
  }

  await sleep(1000)
}

await browser.disconnect()
