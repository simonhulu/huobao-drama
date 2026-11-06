import {createHash} from 'node:crypto';

export const HUPU_HOT_URL = 'https://bbs.hupu.com/cba-hot';
export const SINA_HOME_URL = 'https://sports.sina.com.cn/';
// The homepage's CBA tab calls this endpoint (home_81087f1.js, 2026-11-01).
// The static /cba/ landing page contains an old archive, not this live feed.
export const SINA_CBA_FEED_URL = 'https://interface.sina.cn/sports/pc_sports_caipiao_common_list_api.d.json?ename=cba&last_ts=&page=1&size=20';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
function decode(value) {
  return String(value ?? '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, code) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] || all;
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
  });
}
function text(html) {
  return decode(String(html ?? '').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|section|h[1-6])\s*>|<br\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}
function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
    .map(([, key, a, b]) => [key.toLowerCase(), decode(a ?? b)]));
}
function canonicalUrl(value, provider) {
  try {
    const url = new URL(value, provider === 'hupu' ? HUPU_HOT_URL : SINA_HOME_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (provider === 'hupu' && (url.hostname !== 'bbs.hupu.com' || !/^\/\d+\.html$/.test(url.pathname))) return null;
    if (provider === 'sina' && !(['sports.sina.com.cn', 'sports.sina.cn', 'k.sina.com.cn', 'k.sina.cn'].includes(url.hostname)
      && /(?:\/doc-[\w-]+\.shtml|\/detail-[\w-]+\.d\.html|\/article_[\w-]+\.html)$/.test(url.pathname))) return null;
    url.protocol = 'https:'; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|spm|from|subch|share_source|share_medium)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort(); return url.href;
  } catch { return null; }
}
function timestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 946684800) return null;
  const date = new Date(seconds > 1e12 ? seconds : seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function publicationDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return null;
  const normalized = value.replace(' ', 'T');
  const date = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function articleBody(html) {
  const opening = /<(div|article|section)\b[^>]*(?:id|class)\s*=\s*["'][^"']*\b(?:artibody|article-content|article-body)\b[^"']*["'][^>]*>/i.exec(html);
  if (!opening) return '';
  const tag = opening[1], rest = html.slice(opening.index + opening[0].length);
  const tags = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'); let depth = 1;
  for (const match of rest.matchAll(tags)) {
    depth += match[0].startsWith('</') ? -1 : match[0].endsWith('/>') ? 0 : 1;
    if (!depth) return text(rest.slice(0, match.index));
  }
  return '';
}
function articleMetadata(html) {
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]));
  const meta = key => metas.find(value => (value.property || value.name)?.toLowerCase() === key)?.content;
  const values = [...new Set(metas.filter(value => ['article:published_time', 'og:published_time', 'pubdate', 'publishdate']
    .includes((value.property || value.name || '').toLowerCase())).map(value => publicationDate(value.content)).filter(Boolean))];
  const sourceText = articleBody(html) || meta('og:description') || meta('description') || '';
  return {sourceText: text(sourceText), articleTitle: meta('og:title') || null,
    publishedAt: values.length === 1 ? values[0] : null,
    publicationEvidence: {kind: 'article_metadata', values, conflict: values.length > 1}};
}
const cbaSignal = /\bCBA\b|中国男子篮球职业联赛|(?:广东|四川|福建|江苏|山西|山东|深圳|北京|北控|广州|吉林|辽宁|浙江|广厦|宁波|天津|青岛|新疆|上海|同曦)(?:男篮|队|稠州|马可波罗|肯帝亚|首钢|控股)|浙江广厦|浙江稠州|深圳马可波罗|江苏肯帝亚|北京首钢/i;
const otherCompetition = /\bNBA\b|\bWNBA\b|\bCUBA\b|\bU(?:16|17|18|19)\b|足球|中超|英超|西甲|欧冠|国家队|世预赛|亚运|女篮|男篮世界杯|亚洲杯/i;
const teamLabel = /^(?:广东|四川|福建|江苏|山西|山东|深圳|北京|北控|广州|吉林|辽宁|浙江|广厦|宁波|天津|青岛|新疆|上海|同曦)$/;
function isCbaStory(row, sourceText = '') {
  const labels = Array.isArray(row.labels_show) ? row.labels_show : [];
  const content = `${row.title || ''} ${row.summary || ''} ${labels.join(' ')} ${sourceText}`;
  if (/\bCBA\b|中国男子篮球职业联赛/i.test(content)) return true;
  if (otherCompetition.test(`${row.title || ''} ${labels.join(' ')}`)) return false;
  return cbaSignal.test(content) || labels.some(label => teamLabel.test(label));
}

/** Snapshot the two requested entry pages, not a synthesized set of search hits. */
export async function fetchCbaNewsIntake({fetchImpl = globalThis.fetch, timeoutMs = 20_000, articleMetadataLimit = 8} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw Error('timeoutMs must be a positive integer');
  if (!Number.isInteger(articleMetadataLimit) || articleMetadataLimit < 0 || articleMetadataLimit > 20) throw Error('articleMetadataLimit must be between 0 and 20');
  const retrievedAt = new Date().toISOString();
  async function request(url, report) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(url, {signal, cache: 'no-store', headers: {'Accept': 'text/html,application/json', 'Cache-Control': 'no-cache', 'User-Agent': 'CbaNewsWorkbench/1.0'}});
      const rawBody = await response.text();
      report.evidence.push({url, httpStatus: response.status, responseDate: response.headers.get('date'), rawBody, sha256: sha256(rawBody)});
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      return rawBody;
    } catch (error) {
      if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) throw Error(`获取超时（${timeoutMs}ms）`);
      if (/^HTTP \d+$/.test(error?.message || '')) throw error;
      throw Error('连接或读取失败', {cause: error});
    }
  }
  async function capture(provider) {
    const report = {provider, label: provider === 'hupu' ? '虎扑 CBA 热榜' : '新浪体育 CBA', entryUrl: provider === 'hupu' ? HUPU_HOT_URL : SINA_HOME_URL,
      retrievedAt, status: 'ok', total: 0, rawCount: 0, excludedCount: 0, duplicateCount: 0, evidence: []};
    const items = [], excludedItems = [], seen = new Set();
    const exclude = (row, classification, reason) => excludedItems.push({provider, url: canonicalUrl(row.url, provider), title: text(row.title), classification, reason});
    const add = item => { if (seen.has(item.url)) { report.duplicateCount++; return; } seen.add(item.url); items.push(item); };
    try {
      const html = await request(report.entryUrl, report);
      if (provider === 'hupu') {
        const serialized = /window\.\$\$data\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i.exec(html)?.[1];
        let data; try { data = JSON.parse(serialized); } catch { throw Error('未读取到虎扑热榜列表，页面结构改变或访问受限'); }
        const rows = data?.topic?.threads?.list;
        if (!Array.isArray(rows) || !rows.length || String(data.topic.topic?.topicId) !== '173') throw Error('虎扑 CBA 热榜列表为空或栏目身份不符');
        report.rawCount = rows.length;
        for (const [index, row] of rows.entries()) {
          const url = canonicalUrl(row.url, provider), title = text(row.title);
          if (!url || !title) { exclude(row, 'invalid', '缺少安全的新闻正文链接或标题'); continue; }
          if (!/^\[流言板\]/.test(title) || !(String(row.author?.puid) === '56098302' || /^虎扑(?:篮球|CBA)(?:资讯|新闻)$/.test(row.author?.puname || ''))) {
            exclude(row, 'forum_discussion', '论坛讨论或未经确认的发帖者，不能当作新闻事实'); continue;
          }
          const postId = /^\/(\d+)\.html$/.exec(new URL(url).pathname)[1];
          add({url, title, provider, sourceEntryUrl: report.entryUrl, newsId: `hupu-${postId}`, postId,
            publishedAt: null, listingPublishedAt: timestamp(row.createdAt), articleStatus: 'pending',
            sourceOrder: index + 1, hasVideoHint: row.hasVideo === true, classification: 'news_report',
            selectionReason: 'CBA 热榜中的虎扑资讯新闻帖，正文事实和比赛身份仍须核实'});
        }
      } else {
        if (!/data-type\s*=\s*["']cba["']|href\s*=\s*["'](?:https?:)?\/\/sports\.sina\.com\.cn\/cba\//i.test(html)) throw Error('新浪体育首页未显示 CBA 栏目，不能确认本次来源');
        const rawBody = await request(SINA_CBA_FEED_URL, report);
        let payload; try { payload = JSON.parse(rawBody); } catch { throw Error('新浪 CBA 栏目接口未返回有效 JSON'); }
        const rows = payload?.result?.data?.items;
        if (payload?.result?.status?.code !== 0 || !Array.isArray(rows) || !rows.length) throw Error('新浪 CBA 栏目接口业务失败或列表为空');
        report.rawCount = rows.length; report.apiUrl = SINA_CBA_FEED_URL;
        let metadataCount = 0;
        for (const [index, row] of rows.entries()) {
          const url = canonicalUrl(row.url, provider), title = text(row.title);
          if (!url || !title) { exclude(row, 'invalid', '缺少新浪新闻正文链接或标题'); continue; }
          if (seen.has(url)) { report.duplicateCount++; continue; }
          const labels = Array.isArray(row.labels_show) ? row.labels_show : [];
          if (!/\bCBA\b/i.test(`${title} ${labels.join(' ')}`) && otherCompetition.test(`${title} ${labels.join(' ')}`)) {
            exclude(row, 'other_sport', '标题或标签指向非CBA赛事'); continue;
          }
          const item = {url, title, provider, sourceEntryUrl: report.entryUrl, newsId: `sina-${sha256(url).slice(0, 20)}`, publishedAt: null,
            listingPublishedAt: timestamp(row.ctime), publisher: row.media || null, sourceOrder: index + 1, articleStatus: 'pending',
            classification: new URL(url).hostname.startsWith('k.') ? 'commentary_candidate' : 'news_report',
            selectionReason: '新浪体育 CBA 栏目候选，正文事实和比赛身份仍须核实', requiresCrossCheck: true};
          if (metadataCount < articleMetadataLimit) {
            metadataCount++;
            try { Object.assign(item, articleMetadata(await request(url, report)), {articleStatus: 'read'}); }
            catch (error) { item.articleStatus = 'unavailable'; item.articleError = error.message; }
          }
          // An unread/blocked article or a player-only headline is not evidence
          // of a different competition. Keep it for the research stage; explicit
          // non-CBA headlines were excluded above, without spending this budget.
          if (!isCbaStory(row, item.sourceText)) {
            item.requiresRelevanceCheck = true;
            item.selectionReason = '新浪 CBA 栏目候选，赛事相关性待核实；须补读正文，不能仅凭栏目归属当作CBA新闻事实';
          }
          add(item);
        }
        report.articleMetadataRead = items.filter(item => item.articleStatus === 'read').length;
        report.articleMetadataPending = items.filter(item => item.articleStatus !== 'read').length;
      }
      report.total = items.length; report.excludedCount = excludedItems.length;
      report.message = `读取 ${report.rawCount} 条，筛选 ${report.total} 条 CBA 新闻候选，排除 ${report.excludedCount} 条`;
    } catch (error) { report.status = 'failed'; report.message = `${report.label}：${error.message}`; }
    return {report, items, excludedItems};
  }
  const captures = await Promise.all([capture('hupu'), capture('sina')]);
  const sourceReports = captures.map(value => value.report);
  if (sourceReports.every(report => report.status === 'failed')) throw Error(sourceReports.map(report => report.message).join('；'));
  const items = [];
  // Taking the first N items in a production run still includes both available sources.
  for (let index = 0; index < Math.max(...captures.map(value => value.items.length)); index++) {
    for (const captured of captures) if (captured.items[index]) items.push({...captured.items[index], displayOrder: items.length + 1});
  }
  return {version: 2, entryUrl: HUPU_HOT_URL, entryUrls: [HUPU_HOT_URL, SINA_HOME_URL], retrievedAt,
    scope: '虎扑 CBA 24小时榜当前第一页 + 新浪体育首页 CBA 标签首屏20条；筛选新闻，论坛观点和其他赛事留存排除原因',
    total: items.length, rawCount: sourceReports.reduce((sum, report) => sum + report.rawCount, 0),
    duplicateCount: sourceReports.reduce((sum, report) => sum + report.duplicateCount, 0),
    complete: sourceReports.every(report => report.status === 'ok'), items, sourceReports,
    excludedItems: captures.flatMap(value => value.excludedItems),
    timestampNote: 'listingPublishedAt 是列表提供的发稿线索；publishedAt 仅取正文无冲突的明确发布时间，不能视为比赛日期。',
    evidence: {sources: sourceReports.map(({provider, evidence}) => ({provider, requests: evidence.map(({url, httpStatus, sha256}) => ({url, httpStatus, sha256}))}))}};
}
