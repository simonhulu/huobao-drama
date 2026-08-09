// Shared strong text normalization for transplant-mode machine checks.
//
// This module is the SINGLE source of truth for the strong normalization used by:
//   - scripts/scan-wash-overlap.mjs   (copy-paste guard: final script vs raw original)
//   - scripts/validate-production-run.mjs (F0 evidence quotes, F0c comment evidence,
//     kept_sentences reversal, opening_fidelity external-lane scan)
//
// Do NOT fork this logic. tests/scan-wash-overlap.test.mjs locks the behavior and
// locks both consumers to this implementation.

export function normalizeComparableText(text) {
  // Strong normalization family from tools/writing-corpus/check-overlap.mjs:
  // NFKC, keep Han / ASCII letters / digits, lowercase. Punctuation, whitespace,
  // and full/half-width differences are all erased, so a quote stays a substring
  // match even if the copier moves a comma.
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "")
    .toLowerCase();
}

export function normalizedContains(haystackText, needleText) {
  const needle = normalizeComparableText(needleText);
  if (needle.length === 0) return false;
  return normalizeComparableText(haystackText).includes(needle);
}
