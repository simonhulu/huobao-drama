import {selectedEditions} from './editions.mjs';

export const TITLE_POLICY = 'source-date-cba-v1';

const sourceLabel = /^(?:\[流言板\]|【流言板】)\s*/;
const embeddedSourceLabel = /\[流言板\]|【流言板】/;
const embeddedDatePrefix = /\d{4}-\d{2}-\d{2}\s*CBA\s*[｜|]/i;

/** The first seed is the primary report; another source cannot substitute for it. */
export function primaryNewsTitle(job) {
  const seed = job?.match?.seedUrls?.[0];
  if (typeof seed !== 'string' || !seed.trim() || !Array.isArray(job?.sources)) return '';
  const source = job.sources.find(item => item?.url === seed);
  return typeof source?.title === 'string' ? source.title.trim().replace(sourceLabel, '').trim() : '';
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Formatting only: the editor and independent reviewer retain responsibility for meaning. */
export function validateTitlePolicy(job) {
  const policy = job?.profile?.titlePolicy;
  if (policy === undefined) return [];
  if (policy !== TITLE_POLICY) return [`Unsupported profile.titlePolicy: ${String(policy)}`];

  const errors = [];
  let editions;
  try { editions = selectedEditions(job); } catch (error) { return [error.message]; }
  if (job?.match?.verified !== true) errors.push('Title policy requires a verified match');
  if (!isValidDate(job?.match?.date)) errors.push('Title policy requires a valid match.date in YYYY-MM-DD format');
  if (editions.includes('news') && !primaryNewsTitle(job)) errors.push('Title policy requires the primary source title matching match.seedUrls[0]');

  const prefix = `${job?.match?.date} CBA｜`;
  for (const kind of editions) {
    const title = job?.[kind]?.title;
    if (typeof title !== 'string' || !title.startsWith(prefix)) {
      errors.push(`${kind}.title must start with ${prefix}`);
    } else {
      const body = title.slice(prefix.length);
      if (!body.trim()) errors.push(`${kind}.title requires content after the date and CBA prefix`);
      if (embeddedDatePrefix.test(body)) errors.push(`${kind}.title must not repeat a date and CBA prefix`);
    }
    if (typeof title === 'string') {
      if (Array.from(title).length > 50) errors.push(`${kind}.title must not exceed 50 Unicode code points`);
      if (embeddedSourceLabel.test(title)) errors.push(`${kind}.title must not contain the 流言板 source label`);
    }

    const shortTitle = job?.[kind]?.shortTitle;
    if (typeof shortTitle !== 'string' || !shortTitle.trim() || !shortTitle.includes('CBA')) {
      errors.push(`${kind}.shortTitle must be nonempty and contain CBA`);
    }
    if (typeof shortTitle === 'string' && Array.from(shortTitle).length > 16) {
      errors.push(`${kind}.shortTitle must not exceed 16 Unicode code points`);
    }
  }
  return errors;
}

export function publishingTitle(job, kind, target) {
  if (!selectedEditions(job).includes(kind)) throw Error(`Edition ${kind} is not selected for this job`);
  if (job?.profile?.titlePolicy === undefined) {
    return target === 'tencent-video'
      ? Array.from(`${job.match.home}对${job.match.away}${kind === 'news' ? '赛后复盘' : '关键回合'}`).slice(0, 16).join('')
      : Array.from(job[kind]?.title || job.news?.title || '').slice(0, 50).join('');
  }
  const errors = validateTitlePolicy(job);
  if (errors.length) throw Error(`Invalid CBA title policy: ${errors.join('; ')}`);
  return target === 'tencent-video' ? job[kind].shortTitle : job[kind].title;
}
