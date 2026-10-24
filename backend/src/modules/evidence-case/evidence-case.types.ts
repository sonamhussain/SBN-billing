// A7.4 — a case snapshot is the as-recorded, ordered inventory of ONE frozen submission's A7.1 sources, their A7.2
// classifications and A7.3 readiness results, bound by one SHA-256 manifest. It is a descriptive inventory only:
// never an adjudication, submission, account balance, settlement, collection or revenue closure, and never a
// current or latest pointer. INVENTORY_COMPLETE never means ready for adjudication, approved, sent, paid or denied.

export const CASE_CONTRACT_VERSION = 'A7-REVENUE-CASE-1'
// The only upstream contracts a case reads; any other is a provenance conflict, never guessed or chosen as latest.
export const CASE_CLASSIFICATION_CONTRACT = 'A7-EVIDENCE-CLASS-1'
export const CASE_READINESS_CONTRACT = 'A7-ADJ-READINESS-1'

export const assemblyCodes = ['INVENTORY_COMPLETE', 'INVENTORY_INCOMPLETE', 'NO_REVENUE_SOURCES'] as const
export type AssemblyCode = (typeof assemblyCodes)[number]

export const itemReasonCodes = ['SOURCE_ONLY', 'CLASSIFIED_NO_READINESS', 'LINKED'] as const
export type ItemReasonCode = (typeof itemReasonCodes)[number]

// The owners' facts the assembler reads, exactly as they returned them (strings: a forged or future value must reach
// the assembler to be refused, not be rejected by a type).
export type ClassificationLink = { classificationId: string; sourceEvidenceId: string; contractVersion: string; normalizationOutcome: string }
export type ReadinessLink = { readinessId: string; classificationId: string; sourceEvidenceId: string; contractVersion: string; readinessCode: string; reasonCode: string }
export type SourceLinks = { sourceEvidenceId: string; classifications: ClassificationLink[]; readiness: ReadinessLink[] }
// Sources in the A7.1 owner's database-recorded order (received_at, then id).
export type AssemblyInput = { claimSubmissionId: string; organizationId: string; sources: SourceLinks[] }

export type CaseItem = { ordinal: number; sourceEvidenceId: string; classificationId: string | null; readinessId: string | null; itemReasonCode: ItemReasonCode }
export type Assembly = {
  assemblyCode: AssemblyCode
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  items: CaseItem[]
  manifestText: string
  manifestSha256: string
}

// A broken or contradictory upstream link is a provenance conflict: no case is ever recorded for it.
export type AssemblerResult = { ok: true; value: Assembly } | { ok: false; refusal: 'PROVENANCE_CONFLICT'; detail: string }

// §6 — the bounded DTOs: identifiers, the contract, the controlled codes, counts, the manifest digest, actor and
// database time. No PHI, payer content, amount, status, balance, raw evidence or fingerprint.
export type CaseHeaderDto = {
  caseId: string
  claimSubmissionId: string
  contractVersion: string
  assemblyCode: AssemblyCode
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  manifestSha256: string
  recordedByUserId: string
  recordedAt: string
}
export type CaseItemDto = CaseItem
export type CaseDto = CaseHeaderDto & { items: CaseItemDto[] }

// A submission's case headers in database-recorded order (then id, for a stable presentation only).
export type CaseListDto = { items: CaseHeaderDto[] }

// A successful POST: `replayed` is true for the exact idempotent replay (HTTP 200), false for a new case (HTTP 201).
// The body is identical either way.
export type CaseOutcome = { replayed: boolean; case: CaseDto }

// §6 — refusals: broken or contradictory upstream facts are a PROVENANCE conflict (409, nothing written); a
// concurrency problem or an unknown outcome is a CONFLICT (409).
export type CaseErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'REVENUE_EVIDENCE_CASE_PROVENANCE_CONFLICT' | 'REVENUE_EVIDENCE_CASE_CONFLICT'

export type CaseResult<T> = { ok: true; value: T } | { ok: false; code: CaseErrorCode; message: string }
