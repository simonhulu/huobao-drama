import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {digest, editorialDigest, validateJob, writeJson, readJson, fileHash} from './core.mjs';
import {selectedEditions} from './editions.mjs';
const run = promisify(execFile);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export async function buildReview(job, jobDir) {
  const reviewDir = path.join(jobDir, 'review');
  fs.mkdirSync(path.join(reviewDir, 'clips'), {recursive: true});
  const validation = validateJob(job, {ready: true});
  const structural = validateJob(job);
  if (structural.errors.length) throw Error(structural.errors.join('\n'));
  const editions = selectedEditions(job), hasNews = editions.includes('news'), hasHighlights = editions.includes('highlights');
  const selected = new Set([...(hasNews ? job.news?.segments ?? [] : []).flatMap(s => s.clipIds ?? []), ...(hasHighlights ? job.highlights.clipIds : [])]);
  for (const media of job.media) if (await fileHash(media.path) !== media.sha256) throw Error(`Media ${media.id} changed since import; re-import it before building a preview.`);
  const previews = new Map();
  for (const clip of job.clips.filter(c => selected.has(c.id))) {
    const media = job.media.find(m => m.id === clip.mediaId);
    const filename = `${clip.id}.mp4`, file = path.join(reviewDir, 'clips', filename);
    const signature = digest({sha256: media.sha256, start: clip.start, end: clip.end});
    const marker = `${file}.json`;
    if (!fs.existsSync(file) || !fs.existsSync(marker) || readJson(marker).digest !== signature) {
      await run('ffmpeg', ['-v','error','-y','-ss', String(clip.start), '-i', media.path,
        '-t', String(clip.end - clip.start), '-map','0:v:0','-map','0:a:0?', '-vf',
        'scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2,setsar=1',
        '-c:v','libx264','-preset','veryfast','-crf','25','-c:a','aac','-movflags','+faststart',file], {maxBuffer: 2 ** 20});
      writeJson(marker, {digest: signature});
    }
    previews.set(clip.id, `<figure><video controls preload="metadata" src="clips/${esc(filename)}"></video><figcaption>${esc(clip.id)} · ${esc(clip.label)} · 源录像 ${clip.start.toFixed(2)}–${clip.end.toFixed(2)} 秒<br>${esc(clip.verificationNote || '尚未核对具体回合')}</figcaption></figure>`);
  }
  const signature = editorialDigest(job);
  const sequences = [];
  if (!validation.errors.length) {
    for (const [id, title, clipIds] of [
      ['news', '新闻版画面顺序预览', (job.news?.segments ?? []).flatMap(s => s.clipIds ?? [])],
      ['highlights', '集锦版连续预览', job.highlights?.clipIds ?? []],
    ].filter(([id]) => editions.includes(id))) {
      const filename = `${id}-preview.mp4`, file = path.join(reviewDir, filename);
      const marker = `${file}.json`;
      if (!fs.existsSync(file) || !fs.existsSync(marker) || readJson(marker).digest !== signature) {
        const list = path.join(reviewDir, `${id}-playlist.txt`);
        fs.writeFileSync(list, clipIds.map(clipId => `file 'clips/${clipId}.mp4'`).join('\n') + '\n');
        await run('ffmpeg', ['-v','error','-y','-f','concat','-safe','0','-i',list,
          '-c','copy','-movflags','+faststart',file], {maxBuffer: 2 ** 20});
        writeJson(marker, {digest: signature});
      }
      const duration = clipIds.reduce((sum, clipId) => {
        const clip = job.clips.find(c => c.id === clipId);
        return sum + clip.end - clip.start;
      }, 0);
      sequences.push({id, title, path: file, filename, duration});
    }
  }
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(job.news?.title || job.highlights?.title || job.match.id)} · 制作预览</title>
<style>body{max-width:1080px;margin:40px auto;padding:0 24px;background:#f5f3ee;color:#202a32;font:17px/1.8 system-ui}h1,h2{line-height:1.3}h1{font-size:32px}section,figure{background:white;border-radius:12px;padding:20px;margin:16px 0}video{width:100%;max-height:480px;background:#111}small,figcaption{color:#52616d}a{color:#145b91}.notice{border-left:5px solid #d28719;padding:16px;background:#fff5da}code{word-break:break-all}li{margin:8px 0}</style>
<h1>${esc(job.match.home)} — ${esc(job.match.away)}</h1><p>${esc(job.match.date)} · CBA · ${esc(job.match.score || '')} · ${hasNews && hasHighlights ? '横屏双版本' : hasNews ? '横屏新闻版' : '横屏原声集锦'}</p>
${job.profile?.sourceScope === 'highlights' ? '<p class="notice">素材范围：已剪辑集锦，不代表整场比赛覆盖。新闻解读与回合选择限于已核实事实和实际可见画面。</p>' : ''}
<div class="notice">${validation.errors.length ? '预览尚不完整，以下项目完成后才能审核并制作。' : '请检查事实、旁白与画面的对应关系，以及关键回合是否完整。确认后才生成配音和成片。'}<ul>${validation.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>${[...job.blockers,...(job.mediaBlocker?[job.mediaBlocker]:[])].map(e=>`<p>${esc(e)}</p>`).join('')}</div>
${sequences.length ? `<h2>连续观看</h2><p>预览保留现场原声。${hasNews ? '新闻版下方附拟配旁白，当前尚未生成 AI 配音；最终节奏以配音和画面合成为准。' : '原声集锦无需口播配音。'}</p>${sequences.map(s=>`<section><h3>${esc(s.title)} · ${s.duration.toFixed(1)} 秒</h3><video controls preload="metadata" src="${esc(s.filename)}"></video></section>`).join('')}` : ''}
${fs.existsSync(path.join(jobDir,'inspection/caption-layout-preview.jpg')) ? '<section><h2>字幕位置参考</h2><p>字幕放在底部比分牌上方，保留球队、比分和比赛时钟。</p><img src="../inspection/caption-layout-preview.jpg" alt="真实比赛画面上的双行中文字幕位置" style="width:100%;height:auto"></section>' : ''}
${hasNews ? `<h2>新闻版 · ${esc(job.news.title)}</h2><p>${esc(job.news.summary)}</p>` : ''}
${(hasNews ? job.news.segments : []).map(s=>`<section><small>${esc(s.id)} · ${s.mode==='original'?'现场原声':'AI 旁白'}</small><p>${esc(s.text)}</p><small>事实依据：${(s.factIds??[]).map(esc).join('、')}</small>${(s.clipIds??[]).map(id=>previews.get(id)||`<p>片段 ${esc(id)} 尚缺素材</p>`).join('')}${!s.clipIds?.length?'<p class="notice">待提供录像后定位画面；尚未分配时间码。</p>':''}</section>`).join('')}
${hasHighlights ? `<h2>集锦版 · ${esc(job.highlights.title)}</h2>${job.highlights.clipIds.map(id=>previews.get(id)||'').join('')||`<p>等待${job.profile?.sourceScope === 'highlights' ? '对应集锦素材' : '完整回放'}，尚未生成集锦剪辑表。</p>`}` : ''}
<h2>事实与来源</h2><ul>${job.facts.map(f=>`<li>${esc(f.id)}：${esc(f.text)} <small>${(f.sourceIds??[]).map(esc).join('、')}</small></li>`).join('')}</ul><ul>${job.sources.map(s=>`<li><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a> · ${esc(s.id)}</li>`).join('')}</ul>
<p>${validation.warnings.map(esc).join('<br>')}</p><small>预览版本：<code>${signature}</code></small></html>`;
  fs.writeFileSync(path.join(reviewDir, 'index.html'), html);
  if (hasNews) fs.writeFileSync(path.join(jobDir, 'news-draft.md'), `# ${job.news.title}\n\n${(hasNews ? job.news.segments : []).map(s=>s.text).join('\n\n')}\n`);
  writeJson(path.join(reviewDir, 'validation.json'), validation);
  job.review = {digest: signature, at: new Date().toISOString(), complete: !validation.errors.length,
    path: path.join(reviewDir, 'index.html'), clipCount: previews.size, sequences};
  return job.review;
}
