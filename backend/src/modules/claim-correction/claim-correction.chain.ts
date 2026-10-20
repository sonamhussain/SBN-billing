// A6.9 §4/§6 — the one pure correction-chain logic. Nothing here reads a clock, the environment or the
// database: the caller supplies the immutable links and the freezes' database-authored instants.
//
// * orderCorrectionChain derives the Claim's single linear chain (root to tail) from its links, and refuses
//   any graph it cannot trust: a self link, a fork (one prior, two corrections), a join (one correction, two
//   priors), a cycle, or more than one chain. It never orders by identifier or time.
// * admitCorrectionLink decides whether one new link may extend that chain: the two freezes are distinct,
//   rest on distinct draft assessments, the correction was frozen strictly after the prior (an equal instant
//   is ambiguous and refused, never broken by identifier), and the link extends the chain at its tail.

export type ChainLink = { id: string; priorSubmissionId: string; correctedSubmissionId: string }

export type ChainOrder<T extends ChainLink> = { ok: true; links: T[]; submissions: string[] } | { ok: false; reason: string }

export function orderCorrectionChain<T extends ChainLink>(links: readonly T[]): ChainOrder<T> {
  if (links.length === 0) return { ok: true, links: [], submissions: [] }
  const byPrior = new Map<string, T>()
  const byCorrected = new Map<string, T>()
  for (const link of links) {
    if (link.priorSubmissionId === link.correctedSubmissionId) return { ok: false, reason: 'a link corrects a freeze with itself' }
    if (byPrior.has(link.priorSubmissionId)) return { ok: false, reason: 'a freeze is corrected twice (fork)' }
    if (byCorrected.has(link.correctedSubmissionId)) return { ok: false, reason: 'a freeze corrects two freezes (join)' }
    byPrior.set(link.priorSubmissionId, link)
    byCorrected.set(link.correctedSubmissionId, link)
  }
  // The root is the one prior that is nobody's correction. None means a cycle; two or more mean two chains.
  const roots = links.filter((link) => !byCorrected.has(link.priorSubmissionId))
  if (roots.length === 0) return { ok: false, reason: 'the links form a cycle' }
  if (roots.length > 1) return { ok: false, reason: 'the links form more than one chain' }
  const ordered: T[] = []
  const submissions = [roots[0].priorSubmissionId]
  for (let link: T | undefined = roots[0]; link !== undefined; link = byPrior.get(link.correctedSubmissionId)) {
    if (ordered.length >= links.length) return { ok: false, reason: 'the links form a cycle' }
    ordered.push(link)
    submissions.push(link.correctedSubmissionId)
  }
  if (ordered.length !== links.length) return { ok: false, reason: 'the links form a cycle or more than one chain' }
  return { ok: true, links: ordered, submissions }
}

export type FreezeFacts = { id: string; claimId: string; draftAssessmentId: string; frozenAtMicros: number }

export type Admission = { ok: true } | { ok: false; reason: string }

export function admitCorrectionLink(chainSubmissions: readonly string[], prior: FreezeFacts, corrected: FreezeFacts): Admission {
  if (prior.id === corrected.id) return { ok: false, reason: 'a freeze cannot correct itself' }
  if (prior.claimId !== corrected.claimId) return { ok: false, reason: 'the two freezes belong to different claims' }
  if (prior.draftAssessmentId === corrected.draftAssessmentId) return { ok: false, reason: 'the correction rests on the same draft assessment; a correction needs a new assessed draft and approval' }
  if (!Number.isFinite(prior.frozenAtMicros) || !Number.isFinite(corrected.frozenAtMicros)) return { ok: false, reason: 'a freeze instant is unknown' }
  if (corrected.frozenAtMicros === prior.frozenAtMicros) return { ok: false, reason: 'the two freezes share one instant; the order is ambiguous' }
  if (corrected.frozenAtMicros < prior.frozenAtMicros) return { ok: false, reason: 'the correction was frozen before the freeze it corrects' }
  if (chainSubmissions.length > 0) {
    const tail = chainSubmissions[chainSubmissions.length - 1]
    if (chainSubmissions.includes(corrected.id)) return { ok: false, reason: 'the correction is already part of this claim\'s chain' }
    if (prior.id !== tail) return { ok: false, reason: 'the chain grows only at its tail: the prior must be the latest correction' }
  }
  return { ok: true }
}
