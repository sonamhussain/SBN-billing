import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityContextV2 } from '../../shared/rules/applicability-context-v2.ts'
import { rowMatches, type ApplicabilityRow } from '../rule-applicability/rule-applicability.matcher.ts'

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
  | { ok: false; blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' | 'SUPERSEDES_CONTRADICTORY_DATES' }

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

// A3.8 §9 step 9 + §13. A source version X dominates candidate Y when X transitively SUPERSEDES
// Y AND X had already taken effect on the requested businessDate. Before that date the successor
// does not yet govern, so the predecessor legitimately survives as the historical answer.
//
// X is drawn from the whole SUPERSEDES neighbourhood, not just the candidate set: a successor
// that is itself unusable (not yet activated, unverified, out of scope) still determines whether
// its predecessor may answer for this date, and silently ignoring it would resurrect a
// predecessor the evidence says had already been replaced.
//
// Missing or contradictory successor effective dates BLOCK: the date is the only authoritative
// signal, and supersededAt / publicationDate / createdAt must never be used to infer one.
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

  const dominated = new Set<string>()

  for (const superseder of versions) {
    const reachable = reachableFrom(superseder.sourceVersionId, adjacency)
    if (reachable.size === 0) continue

    for (const candidateId of candidates) {
      if (candidateId === superseder.sourceVersionId) continue
      if (!reachable.has(candidateId)) continue

      if (!superseder.effectiveFrom) return { ok: false, blocker: 'SUPERSEDES_EFFECTIVE_DATE_INCOMPLETE' }
      if (superseder.effectiveTo && superseder.effectiveFrom.getTime() > superseder.effectiveTo.getTime())
        return { ok: false, blocker: 'SUPERSEDES_CONTRADICTORY_DATES' }

      if (businessDate.getTime() >= superseder.effectiveFrom.getTime()) {
        dominated.add(candidateId)
      }
    }
  }

  return { ok: true, survivingSourceVersionIds: candidates.filter((id) => !dominated.has(id)) }
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
