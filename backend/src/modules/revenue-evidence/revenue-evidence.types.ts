// A7.1 — a revenue source evidence registration answers one question: which source evidence was registered for
// which exact A6.7 frozen submission, of which controlled kind and opaque reference, by whom and when (database
// time)? It is provenance for later A7 stages only: not a payer adjudication, not a cash receipt, not an amount,
// not a balance and not a claim status. It never changes the freeze, its A6.8 lifecycle or its A6.9 correction
// lineage, and a RELEASE_ELIGIBLE disposition or a correction never turns it into "sent", "paid" or "newest".
//
// A7.2+ normalizes revenue decisions from this evidence; A9 owns any genuine transmission or receipt. Until an
// A9 owner brings an authenticated connector and an independently checkable artifact, the only kind is
// INTERNAL_SYNTHETIC and no source digest exists.

export const REVENUE_SOURCE_CONTRACT_VERSION = 'A7-REVENUE-SOURCE-1'

// §3 — the controlled source kinds. EXTERNAL_VERIFIED is reserved (named so it can be refused explicitly) and is
// not accepted in A7.1, by the API or by the database.
export const REVENUE_SOURCE_KIND_SYNTHETIC = 'INTERNAL_SYNTHETIC'
export const REVENUE_SOURCE_KIND_RESERVED = 'EXTERNAL_VERIFIED'
export const acceptedRevenueSourceKinds = [REVENUE_SOURCE_KIND_SYNTHETIC] as const
export type RevenueSourceKind = (typeof acceptedRevenueSourceKinds)[number]

// §3 — an opaque reference: 3–64 upper-case letters, digits, '.', '_' or '-', starting with a letter or digit.
// The same pattern is a database CHECK.
export const SOURCE_REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{2,63}$/

// §5 — the validated request. The frozen submission comes from the path; organization, actor, contract,
// digest and every instant from the server.
export type RevenueSourceEvidenceRequest = {
  sourceKind: RevenueSourceKind
  sourceReference: string
}

// §5 — the bounded DTO: identifiers, the controlled kind, the opaque reference, contract, actor and database
// time. No PHI, payer content, amount, status, bytes or raw evidence.
export type RevenueSourceEvidenceDto = {
  revenueSourceEvidenceId: string
  claimSubmissionId: string
  sourceKind: RevenueSourceKind
  sourceReference: string
  sourceVersion: string
  sourceDigestSha256: string | null
  receivedAt: string
  recordedByUserId: string
}

// A frozen submission's registrations in database-recorded order (then id, for a stable presentation only —
// the order is never causality).
export type RevenueSourceEvidenceListDto = { items: RevenueSourceEvidenceDto[] }

// A successful POST: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new
// registration (HTTP 201). The body is identical either way.
export type RevenueSourceEvidenceOutcome = { replayed: boolean; evidence: RevenueSourceEvidenceDto }

// §5 — refusals. An integrity or concurrency problem is a safe 409 with no write.
export type RevenueEvidenceErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVENUE_EVIDENCE_CONFLICT'

export type RevenueEvidenceResult<T> = { ok: true; value: T } | { ok: false; code: RevenueEvidenceErrorCode; message: string }
