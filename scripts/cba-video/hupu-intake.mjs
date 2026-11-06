import {createHash} from 'node:crypto';

export const HUPU_HOME_URL = 'https://cba.hupu.com/';
export const HUPU_HOME_API_URL = 'https://games.mobileapi.hupu.com/1/7.5.18/basketballapi/news/v1/getTopNews?page=1&num=24&competitionType=cba&channel=pc';

// #focusNews is populated by the homepage's inline script, not the static HTML.
// These are its DOM insertion indices, verified on 2026-10-24. The four carousel
// images reuse the same news and are not additional stories.
const displayIndices = [0, 1, 6, 7, 8, 9, 10, 11, 2, 3, 12, 13, 14, 15, 16, 17, 4, 5, 18, 19, 20, 21, 22, 23];

function newsUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'bbs.hupu.com'
      || url.port || url.username || url.password || !/^\/\d+\.html$/.test(url.pathname)) return null;
    return `https://bbs.hupu.com${url.pathname}`;
  } catch { return null; }
}

function updatedAt(value) {
  if (!/^\d{10}$/.test(String(value))) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** A complete, evidenced snapshot; no model-decided limit or match-level merge. */
export async function fetchHupuHomepage({fetchImpl = globalThis.fetch, timeoutMs = 20_000} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw Error('timeoutMs must be a positive integer');
  const signal = AbortSignal.timeout(timeoutMs);
  let response, rawBody;
  try {
    response = await fetchImpl(HUPU_HOME_API_URL, {
      signal, cache: 'no-store', headers: {'Accept': 'application/json', 'Cache-Control': 'no-cache', 'Pragma': 'no-cache'},
    });
    if (!response.ok) throw Error(`虎扑首页新闻接口返回 HTTP ${response.status}，本轮未完成扫描`);
    rawBody = await response.text();
  } catch (error) {
    if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) {
      throw Error(`虎扑首页新闻接口获取超时（${timeoutMs}ms），本轮未完成扫描`);
    }
    if (error?.message?.startsWith('虎扑首页新闻接口返回 HTTP')) throw error;
    throw Error('虎扑首页新闻接口连接或读取失败，本轮未完成扫描', {cause: error});
  }
  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { throw Error('虎扑首页新闻接口未返回有效 JSON，本轮未完成扫描'); }
  if (payload?.status !== 200) throw Error(`虎扑首页新闻接口业务失败（status=${String(payload?.status).slice(0, 30)}），本轮未完成扫描`);
  const rows = payload?.result?.data;
  if (!Array.isArray(rows) || rows.length !== displayIndices.length) {
    throw Error(`虎扑首页新闻列表不完整：预期24条，实际${Array.isArray(rows) ? rows.length : '无列表'}条；本轮未完成扫描`);
  }
  const unique = new Map();
  for (const [index, apiIndex] of displayIndices.entries()) {
    const row = rows[apiIndex], url = newsUrl(row?.originLink);
    if (!url) throw Error(`虎扑首页第${index + 1}条不是可读取的新闻正文链接，本轮未完成扫描`);
    if (typeof row.title !== 'string' || !row.title.trim() || !/^\d+$/.test(String(row.nid ?? ''))) {
      throw Error(`虎扑首页第${index + 1}条缺少标题或新闻标识，本轮未完成扫描`);
    }
    if (unique.has(url)) {
      unique.get(url).duplicatePositions.push(index + 1);
      continue;
    }
    unique.set(url, {
      url, title: row.title.trim(), newsId: String(row.nid), postId: /^\/(\d+)\.html$/.exec(new URL(url).pathname)[1],
      publishedAt: null, updatedAt: updatedAt(row.uptime), hasVideoHint: row.imgShowPlay === 1,
      displayOrder: index + 1, apiIndex, duplicatePositions: [],
    });
  }
  const items = [...unique.values()];
  return {
    version: 1, entryUrl: HUPU_HOME_URL, apiUrl: HUPU_HOME_API_URL, retrievedAt: new Date().toISOString(),
    scope: '首页 #focusNews 全部24个新闻位置，按页面展示顺序，轮播图重复链接不另计',
    total: items.length, rawCount: rows.length, duplicateCount: rows.length - items.length,
    timestampNote: 'API uptime 为更新时间，不是发稿时间；publishedAt 须逐篇读取正文 createdAt 核实。',
    items,
    evidence: {httpStatus: response.status, responseDate: response.headers.get('date'), rawBody,
      sha256: createHash('sha256').update(rawBody).digest('hex')},
  };
}
