import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityContextV2 } from '../../shared/rules/applicability-context-v2.ts'
import { rowMatches, type ApplicabilityRow } from '../rule-applicability/rule-applicability.matcher.ts'
import { isEffectiveOn } from '../../shared/rules/date-only.ts'

// A3.8 §6 — returned in every resolver response so future provenance can identify exactly which
// precedence algorithm produced a result.
export const precedencePolicyVersion = 'A3-PREC-1'

// ---------------------------------------------------------------------------------------------
// Applicability specificity (A3.8 §10)
// ---------------------------------------------------------------------------------------------

// Row specificity is the count of non-null dimensions on the row. REF-01 carry-forward: the
// count spans the full twelve-dimension ApplicabilityContextV2, not the older six-dimension
// list — a row constrained to a facility and a provider contract is genuinely more specific
// than a wildcard row, and scoring it 0 would manufacture a false tie.
export function rowSpecificity(row: ApplicabilityRow): number {
  let score = 0
  for (const key of APPLICABILITY_DIMENSIONS_V2) {
    if (row[key] !== null) score += 1
  }
  return score
}

// When a RuleVersion has several matching rows, its score is the highest matching row's score.
// This does not change A3.6's OR-across-rows semantics; it only adds deterministic ranking.
// Returns null when nothing matched, which the caller treats as "not a candidate at all".
export function bestMatchedSpecificity(rows: ApplicabilityRow[], context: ApplicabilityContextV2): number | null {
  let best: number | null = null
  for (const row of rows) {
    if (!rowMatches(row, context)) continue
    const score = rowSpecificity(row)
    if (best === null || score > best) best = score
  }
  return best
}

// Keeps only the highest-specificity entries. Deliberately returns EVERY tied entry rather than
// picking one: A3.8 §9 step 5 requires a tie to block, never to be broken by version string,
// createdAt, updatedAt, effectiveFrom or row order.
export function highestSpecificityCandidates<T extends { specificityScore: number }>(candidates: T[]): T[] {
  if (candidates.length === 0) return []
  let best = candidates[0].specificityScore
  for (const candidate of candidates) {
    if (candidate.specificityScore > best) best = candidate.specificityScore
  }
  return candidates.filter((candidate) => candidate.specificityScore === best)
}

// ---------------------------------------------------------------------------------------------
// SUPERSEDES transitive dominance + historical date rule (A3.8 §12, §13)
// ---------------------------------------------------------------------------------------------

export type SupersedesEdge = {
  fromSourceVersionId: string
  toSourceVersionId: string
}

// Every source version in the SUPERSEDES neighbourhood of the candidates — not only the
// candidates themselves. A successor that is not a usable candidate still decides whether a
// predecessor may answer, so its dates must be available here (A3.8 §13).
export type PrecedenceVersion = {
  sourceVersionId: string
  effectiveFrom: Date | null
  effectiveTo: Date | null
}

export type DominanceOutcome =
  | { ok: true; survivingSourceVersionIds: string[] }
  | {
      ok: false
      blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' | 'SUPERSEDES_CONTRADICTORY_DATES' | 'SUPERSEDES_SUCCESSOR_UNUSABLE'
    }

function buildAdjacency(edges: SupersedesEdge[]): Map<string, string[]> {
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const existing = adjacency.get(edge.fromSourceVersionId)
    if (existing) existing.push(edge.toSourceVersionId)
    else adjacency.set(edge.fromSourceVersionId, [edge.toSourceVersionId])
  }
  return adjacency
}

// Everything reachable from `startId` by following SUPERSEDES edges, excluding the start itself
// unless it is genuinely reachable from itself. A3.4 already guarantees the graph is acyclic;
// the visited set is a defensive guard, not a substitute for that guarantee.
function reachableFrom(startId: string, adjacency: Map<string, string[]>): Set<string> {
  const reached = new Set<string>()
  const queue = [...(adjacency.get(startId) ?? [])]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (reached.has(current)) continue
    reached.add(current)
    for (const next of adjacency.get(current) ?? []) queue.push(next)
  }
  return reached
}

// A3.8 §9 step 9 + §13. A source version X supersedes candidate Y for businessDate when X
// transitively SUPERSEDES Y AND X is in force on businessDate — its complete inclusive window
// effectiveFrom <= businessDate <= effectiveTo, a null effectiveTo being open-ended. Before X takes
// effect, or after X's own period has ended, X does not govern that date, so Y legitimately
// survives as the answer. "Already in force" below means exactly this window.
//
// X is drawn from the whole SUPERSEDES neighbourhood, not just the candidate set, because a
// successor that is itself unusable still decides whether its predecessor may answer. The caller
// passes as candidates exactly the versions that passed the shared governing gate for this rule
// and date, so "usable" means "is a candidate". For each candidate Y:
//
//   - some USABLE successor already in force reaches Y -> ordinary dominance: Y is removed and
//     that successor (or its own successor) answers;
//   - otherwise, some UNUSABLE successor already in force reaches Y (unverified, not bound to this
//     rule, out of scope, not ACTIVE...) -> the whole resolution BLOCKS with
//     SUPERSEDES_SUCCESSOR_UNUSABLE. Y must not win, because the evidence says it was replaced;
//     and no unrelated candidate may win merely because Y dropped out, because nothing valid
//     replaced it (audit, A3.8 precedence edge case);
//   - otherwise Y survives.
//
// A transitive chain is covered: if usable Z supersedes unusable X which supersedes Y, Z reaches
// Y and dominates it normally, so an unusable middle link that has itself been replaced never
// blocks.
//
// Missing or contradictory successor effective dates BLOCK first, exactly as before: the date is
// the only authoritative signal, and supersededAt / publicationDate / createdAt must never be
// used to infer one. Every problem is collected before deciding, and the blockers are chosen by a
// fixed priority, so the outcome never depends on candidate, version or edge order.
//
// Candidate validity for businessDate is established by the caller; it is not re-derived here,
// which keeps this function pure and side-effect free.
export function resolveSupersedesDominance(
  candidateSourceVersionIds: string[],
  versions: PrecedenceVersion[],
  edges: SupersedesEdge[],
  businessDate: Date,
): DominanceOutcome {
  const adjacency = buildAdjacency(edges)
  const candidates: string[] = []
  for (const id of candidateSourceVersionIds) {
    if (!candidates.includes(id)) candidates.push(id)
  }
  const usable = new Set(candidates)

  let incompleteDates = false
  let contradictoryDates = false
  const dominatedByUsable = new Set<string>()
  const supersededByUnusable = new Set<string>()

  for (const superseder of versions) {
    const reachable = reachableFrom(superseder.sourceVersionId, adjacency)
    if (reachable.size === 0) continue

    for (const candidateId of candidates) {
      if (candidateId === superseder.sourceVersionId) continue
      if (!reachable.has(candidateId)) continue

      if (!superseder.effectiveFrom) {
        incompleteDates = true
        continue
      }
      if (superseder.effectiveTo && superseder.effectiveFrom.getTime() > superseder.effectiveTo.getTime()) {
        contradictoryDates = true
        continue
      }

      // In force = the complete inclusive window effectiveFrom <= businessDate <= effectiveTo, with a
      // null effectiveTo open-ended — the same shared rule used everywhere else (F07). A successor
      // whose own period had already ended before businessDate does not count against Y, usable or
      // not (audit: expired-successor boundary).
      if (isEffectiveOn(superseder.effectiveFrom, superseder.effectiveTo, businessDate)) {
        if (usable.has(superseder.sourceVersionId)) dominatedByUsable.add(candidateId)
        else supersededByUnusable.add(candidateId)
      }
    }
  }

  if (incompleteDates) return { ok: false, blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' }
  if (contradictoryDates) return { ok: false, blocker: 'SUPERSEDES_CONTRADICTORY_DATES' }

  // A candidate replaced by an unusable successor, and by no usable one, cannot be removed
  // quietly: that would hand the answer to whatever else happened to be a candidate.
  for (const candidateId of supersededByUnusable) {
    if (!dominatedByUsable.has(candidateId)) return { ok: false, blocker: 'SUPERSEDES_SUCCESSOR_UNUSABLE' }
  }

  return { ok: true, survivingSourceVersionIds: candidates.filter((id) => !dominatedByUsable.has(id)) }
}

// ---------------------------------------------------------------------------------------------
// CONFLICTS_WITH fail-closed check (A3.8 §9 step 12)
// ---------------------------------------------------------------------------------------------

export type ConflictEdge = {
  fromSourceVersionId: string
  toSourceVersionId: string
}

// A conflicting source version should already have been blocked by A3.7's gate. If two
// surviving governing candidates are nevertheless linked by CONFLICTS_WITH, A3.8 fails closed
// rather than picking one of them.
export function hasConflictAmong(sourceVersionIds: string[], edges: ConflictEdge[]): boolean {
  const present = new Set(sourceVersionIds)
  return edges.some(
    (edge) =>
      edge.fromSourceVersionId !== edge.toSourceVersionId &&
      present.has(edge.fromSourceVersionId) &&
      present.has(edge.toSourceVersionId),
  )
}
