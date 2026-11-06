/** Missing editions preserves every existing two-video job without migrating it. */
export function selectedEditions(job) {
  const editions = job?.profile?.editions;
  if (editions === undefined) return ['news', 'highlights'];
  if (Array.isArray(editions) && (editions.length === 1 && ['news', 'highlights'].includes(editions[0])
      || editions.length === 2 && editions[0] === 'news' && editions[1] === 'highlights')) {
    return [...editions];
  }
  throw Error('Profile editions must be ["news"], ["highlights"] or ["news","highlights"]');
}
