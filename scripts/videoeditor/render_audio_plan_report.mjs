import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const percent = (value, durationMs) => `${Math.max(0, Math.min(100, value / durationMs * 100)).toFixed(4)}%`;

function bar(item, durationMs, className, label) {
  return `<div class="bar ${className}" style="left:${percent(item.startMs, durationMs)};width:${percent(item.endMs - item.startMs, durationMs)}" title="${escapeHtml(label)}"><span>${escapeHtml(label)}</span></div>`;
}

export function renderAudioPlanReportHtml({props, audioDesign, title = 'Narrative Audio Plan'}) {
  const lanes = [
    {name: 'Narrative sequences', className: 'sequence', items: props.sequences.map((item) => ({...item, label: item.title ?? item.id}))},
    {name: 'BGM', className: 'bgm', items: audioDesign.bgmTracks.map((item) => ({...item, label: `${item.id} · ${(item.tags ?? []).slice(0, 3).join(' / ')}`}))},
    {name: 'Ambience', className: 'ambience', items: audioDesign.soundCues.filter((item) => item.role === 'ambience').map((item) => ({...item, label: item.id}))},
    {name: 'Foley', className: 'foley', items: audioDesign.soundCues.filter((item) => item.role === 'foley').map((item) => ({...item, label: item.id}))},
    {name: 'Impacts', className: 'impact', items: audioDesign.soundCues.filter((item) => item.role === 'impact').map((item) => ({...item, label: item.id}))},
  ];
  const decisions = audioDesign.decisions.map((decision) => `<tr><td>${escapeHtml(decision.kind)}</td><td>${escapeHtml(decision.targetId)}</td><td>${escapeHtml(decision.eventType ?? decision.profile)}</td><td>${escapeHtml(decision.selectedPath)}</td><td>${escapeHtml(decision.score)}</td></tr>`).join('');
  const unresolved = audioDesign.unresolvedEvents.length === 0
    ? '<p class="ok">No unresolved soundable events.</p>'
    : `<ul>${audioDesign.unresolvedEvents.map((event) => `<li><strong>${escapeHtml(event.eventType)}</strong> · ${escapeHtml(event.text)} · ${escapeHtml(event.reason)}</li>`).join('')}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#111315;color:#edf0ed}*{box-sizing:border-box}body{margin:0;padding:28px;background:#111315}main{max-width:1400px;margin:0 auto}h1{font-size:28px;margin:0 0 6px}p{color:#aeb7b2}.metrics{display:flex;gap:18px;flex-wrap:wrap;margin:20px 0 28px}.metric{padding:10px 14px;border-left:3px solid #d3a447;background:#1a1e20}.metric strong{display:block;font-size:22px}.timeline{border-top:1px solid #343a3d}.lane{display:grid;grid-template-columns:150px 1fr;min-height:58px;border-bottom:1px solid #2b3033}.lane-name{padding:18px 12px;color:#bdc5c0}.track{position:relative;margin:8px 0;background:#171a1c;overflow:hidden}.bar{position:absolute;top:4px;bottom:4px;min-width:2px;border-radius:3px;overflow:hidden}.bar span{display:block;padding:8px;font-size:12px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.sequence{background:#394047}.bgm{background:#9a7130}.ambience{background:#47715a}.foley{background:#306b83}.impact{background:#934943}.details{margin-top:30px;display:grid;grid-template-columns:2fr 1fr;gap:24px}section{min-width:0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid #303639;vertical-align:top}th{color:#aeb7b2}.ok{color:#87c995}@media(max-width:800px){body{padding:14px}.lane{grid-template-columns:1fr}.lane-name{padding:9px 4px}.track{height:54px}.details{grid-template-columns:1fr}}
</style>
</head>
<body><main>
<h1>${escapeHtml(title)}</h1>
<p>${(props.durationMs / 1000).toFixed(3)} seconds · one narration master · deterministic local-library plan</p>
<div class="metrics">
<div class="metric"><strong>${audioDesign.bgmTracks.length}</strong>BGM sections</div>
<div class="metric"><strong>${audioDesign.soundCues.length}</strong>sound cues</div>
<div class="metric"><strong>${Math.round(audioDesign.metrics.soundableEventCoverage * 100)}%</strong>soundable-event coverage</div>
<div class="metric"><strong>${audioDesign.unresolvedEvents.length}</strong>unresolved</div>
</div>
<div class="timeline">${lanes.map((lane) => `<div class="lane"><div class="lane-name">${escapeHtml(lane.name)}</div><div class="track">${lane.items.map((item) => bar(item, props.durationMs, lane.className, item.label)).join('')}</div></div>`).join('')}</div>
<div class="details"><section><h2>Decisions</h2><table><thead><tr><th>Kind</th><th>Target</th><th>Intent</th><th>Selected asset</th><th>Score</th></tr></thead><tbody>${decisions}</tbody></table></section><section><h2>Unresolved events</h2>${unresolved}</section></div>
</main></body></html>`;
}

export function writeAudioPlanReport({props, audioDesign, jsonPath, htmlPath, title}) {
  mkdirSync(path.dirname(jsonPath), {recursive: true});
  mkdirSync(path.dirname(htmlPath), {recursive: true});
  writeFileSync(jsonPath, `${JSON.stringify(audioDesign, null, 2)}\n`);
  writeFileSync(htmlPath, renderAudioPlanReportHtml({props, audioDesign, title}));
  return {jsonPath, htmlPath};
}
