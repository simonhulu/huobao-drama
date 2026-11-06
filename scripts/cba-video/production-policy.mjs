import {selectedEditions} from './editions.mjs';

export const CBA_PRODUCTION_POLICY = 'cba-value-v2';
export const CBA_NARRATION_POLICY = 'xiaolu-commentator-v1';
export const CBA_NARRATION_OPENING = '大家好，我们是你们的评论员小鹭';
export const PRODUCTION_LIMITS = Object.freeze({
  news: Object.freeze({minimumSeconds: 30, targetSeconds: Object.freeze([60, 180]), minimumNarrationCharacters: 80, minimumNarrationSeconds: 20}),
  highlights: Object.freeze({minimumSeconds: 90, targetSeconds: Object.freeze([180, 300]), minimumCompletePlays: 3}),
});
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const clipSeconds = clip => clip && finite(clip.start) && finite(clip.end) ? Math.max(0, clip.end - clip.start) : 0;
const characters = text => [...String(text || '').replace(/[\p{P}\p{Z}\s]/gu, '')].length;
const commentatorLimits = Object.freeze({minimumSeconds: 60, targetSeconds: Object.freeze([90, 180]), minimumNarrationCharacters: 300, minimumNarrationSeconds: 60});
const newsLimits = job => job?.profile?.narrationPolicy === CBA_NARRATION_POLICY ? commentatorLimits : PRODUCTION_LIMITS.news;
const sourceFraming = /虎扑|新浪|(?:这|该|本)(?:一)?篇(?:赛后)?(?:报道|文章|评论)|原文|原报道|文中|作者(?:认为|提到|指出|关注|分析)/u;

/** Read-only projection shared by the editor gate, delivery check and workbench.
 * Only the versioned profile is strict: existing delivered files remain usable.
 * Duration preferences never override the fixed minimum production requirements. */
export function productionQuality(job, {durations = {}, enforce = job?.profile?.productionPolicy === CBA_PRODUCTION_POLICY} = {}) {
  const editions = selectedEditions(job), errors = [], warnings = [], metrics = {};
  const clips = new Map((job?.clips || []).map(clip => [clip.id, clip]));
  const media = new Map((job?.media || []).map(item => [item.id, item]));
  const strict = enforce === true;
  const issue = message => (strict ? errors : warnings).push(message);
  for (const kind of editions) {
    const limits = kind === 'news' ? newsLimits(job) : PRODUCTION_LIMITS[kind];
    const segments = kind === 'news' ? job?.news?.segments || [] : [];
    const ids = kind === 'news' ? segments.flatMap(segment => segment.clipIds || []) : job?.highlights?.clipIds || [];
    const selected = ids.map(id => clips.get(id)).filter(Boolean);
    const footageSeconds = selected.reduce((total, clip) => total + clipSeconds(clip), 0);
    const durationSeconds = Object.hasOwn(durations, kind) ? durations[kind] : undefined;
    metrics[kind] = {durationSeconds: finite(durationSeconds) ? durationSeconds : null, footageSeconds,
      minimumSeconds: limits.minimumSeconds, targetSeconds: [...limits.targetSeconds]};
    if (durationSeconds !== undefined && (!finite(durationSeconds) || durationSeconds + .05 < limits.minimumSeconds)) {
      issue(`${kind === 'news' ? '新闻口播' : '比赛集锦'}仅 ${finite(durationSeconds) ? durationSeconds.toFixed(1) : '未知'} 秒，最低要求 ${limits.minimumSeconds} 秒；信息或素材不足，不能作为新版成片交付。`);
    } else if (finite(durationSeconds) && (durationSeconds < limits.targetSeconds[0] || durationSeconds > limits.targetSeconds[1])) {
      warnings.push(`${kind === 'news' ? '新闻口播' : '比赛集锦'} ${durationSeconds.toFixed(1)} 秒，建议 ${limits.targetSeconds.join('–')} 秒；按有效内容取舍，不重复画面凑时长。`);
    }
    if (kind === 'news') {
      const narrated = segments.filter(segment => segment.mode !== 'original');
      const narrationCharacters = narrated.reduce((sum, segment) => sum + characters(segment.text), 0);
      metrics.news.narrationCharacters = narrationCharacters;
      if (strict && narrationCharacters < limits.minimumNarrationCharacters) errors.push(`新闻口播信息不足：至少 ${limits.minimumNarrationCharacters} 个有效文字，并交代原报道的事件、数据和已知后续；不能用空话补足。`);
      if (job?.profile?.narrationPolicy === CBA_NARRATION_POLICY) {
        if (!String(narrated[0]?.text || '').trim().startsWith(CBA_NARRATION_OPENING)) errors.push(`小鹭口播须以“${CBA_NARRATION_OPENING}”开场，身份介绍只在开头出现一次。`);
        for (const segment of narrated) {
          const match = String(segment.text || '').match(sourceFraming);
          if (match) errors.push(`新闻段落 ${segment.id} 含素材转述口吻“${match[0]}”；把已核实事实组织为小鹭自己的篮球评论，媒体名与原文说明保留在后台来源记录。`);
        }
      }
    } else {
      metrics.highlights.completePlayCount = selected.filter(clip => clip.verified === true && clip.completePlay === true).length;
      if (strict && metrics.highlights.completePlayCount < limits.minimumCompletePlays) errors.push(`比赛集锦至少需要 ${limits.minimumCompletePlays} 个已核验完整回合，核对动作和结果后标注 completePlay:true。`);
    }
    if (!strict) continue;
    if (footageSeconds + .05 < limits.minimumSeconds) errors.push(`${kind === 'news' ? '新闻口播' : '比赛集锦'}的实际比赛画面不足 ${limits.minimumSeconds} 秒；请补足有效镜头，不能靠停帧或重复补时。`);
    const intervals = new Map();
    for (const clip of selected) {
      const source = media.get(clip.mediaId), key = source?.sha256 || source?.path || clip.mediaId;
      const previous = intervals.get(key) || [];
      if (previous.some(other => clip.start < other.end - .01 && clip.end > other.start + .01)) {
        errors.push(`${kind === 'news' ? '新闻口播' : '比赛集锦'}重复使用同一素材时间：${clip.id}；请选择不同的比赛片段。`);
      }
      previous.push(clip); intervals.set(key, previous);
    }
  }
  return {policy: job?.profile?.productionPolicy || 'legacy', editions, errors: [...new Set(errors)], warnings: [...new Set(warnings)], metrics};
}

/** Call with measured audio durations before rendering; script estimates are not
 * evidence that narration fits the selected moving footage. */
export function assertNarrationCoverage(job, segments) {
  if (job?.profile?.productionPolicy !== CBA_PRODUCTION_POLICY || !selectedEditions(job).includes('news')) return;
  let duration = 0, speech = 0;
  for (const segment of segments) {
    if (![segment.footageSeconds, segment.narrationSeconds, segment.narrationEnd].every(finite)) throw Error('新闻配音或画面实际时长无效，请重新检查素材。');
    if (segment.narrationEnd > segment.footageSeconds + .25) {
      throw Error(`新闻段落 ${segment.id} 的口播超过比赛画面 ${(segment.narrationEnd - segment.footageSeconds).toFixed(1)} 秒；请补足同场画面或精简稿件，禁止停帧补时。`);
    }
    duration += Math.max(segment.footageSeconds, segment.narrationEnd);
    speech += segment.narrationSeconds;
  }
  const limits = newsLimits(job);
  if (speech + .05 < limits.minimumNarrationSeconds || speech < duration * .5) {
    throw Error(`新闻口播实际语音不足：至少 ${limits.minimumNarrationSeconds} 秒，并覆盖成片时长的一半；请围绕同一主题组织已核实的相关报道和篮球分析，不能用大段无口播画面凑时长。`);
  }
}


/** An editor must preserve the article-to-game evidence; a verified flag alone
 * does not establish which game the story describes. The reviewer reads it. */
export function matchEvidenceErrors(job) {
  if (job?.profile?.productionPolicy !== CBA_PRODUCTION_POLICY) return [];
  const evidence = job.matchEvidence;
  if (evidence?.status !== 'confirmed' || typeof evidence.reason !== 'string' || !evidence.reason.trim()
      || typeof evidence.sourceExcerpt !== 'string' || !evidence.sourceExcerpt.trim()) {
    return ['新闻与比赛的关联证据不完整：matchEvidence 需 confirmed、reason 和 sourceExcerpt；请从已保存的来源正文核对日期与双方，不能仅凭球队名或发稿日认定。'];
  }
  const sources = new Map((job.sources || []).map(source => [source.id, source]));
  if (!Array.isArray(evidence.sourceIds) || !evidence.sourceIds.length || evidence.sourceIds.some(id => !sources.has(id))
      || !evidence.sourceIds.some(id => typeof sources.get(id)?.text === 'string' && sources.get(id).text.trim())) {
    return ['比赛关联必须引用实际存在且保存了正文的 sourceIds，缺少原文依据时保持待核实。'];
  }
  return [];
}
