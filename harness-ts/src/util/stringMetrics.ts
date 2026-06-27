/**
 * Domain-neutral string similarity helpers.
 *
 * Lives in util/ (not autonomy/ or learning/) so cross-domain callers --
 * goal dedup, memory-correction matching -- share one implementation without
 * importing across feature boundaries (#846).
 */

/**
 * Token-overlap similarity in [0, 1]. Lowercases, strips non-alphanumerics to
 * spaces, tokenizes on whitespace, and returns sharedTokens / max(|a|, |b|).
 * Max-normalized so a short string fully contained in a long one does not score 1.
 */
export function tokenOverlap(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean))
  const ta = tokenize(a)
  const tb = tokenize(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) {
    if (tb.has(t)) shared++
  }
  return shared / Math.max(ta.size, tb.size)
}
