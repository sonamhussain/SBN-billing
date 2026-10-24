import {
  BASIS_OF,
  PREREQ_CASE_CONTRACT,
  PREREQ_READINESS_CONTRACT,
  type AssessmentCode,
  type CaseHeaderFacts,
  type CaseItemFacts,
  type DerivationResult,
  type ReadinessFacts,
} from './case-prerequisite.types.ts'

// A7.5 §5 — the one pure, deterministic case-level reducer. It reads the STORED A7.4 header and items and the STORED
// A7.3 readiness of each linked item; it never re-assembles the case, recomputes its manifest, re-runs the A7.2
// classifier or re-derives an A7.3 readiness. No clock, locale, time zone, environment, database, network,
// randomness, price or payer financial value is read: the same facts always give the same result.
//
// Priority (§3): no source -> incomplete chain -> review required -> unsupported -> external financial evidence
// absent. A source with an absent link is never assumed ready, and nothing here can say "ready for closure".
//
// Fail closed (a provenance conflict, nothing recorded) when the case contradicts A7-REVENUE-CASE-1: another contract,
// a malformed digest, an uncontrolled assembly code, counts that disagree with each other or with the items, ordinals
// that are not exactly 1..N, a repeated source, an item whose reason disagrees with its links, a code that disagrees
// with its items, or a linked readiness that is missing, extra, of another classification, source or contract, or
// not one of the three approved readiness/reason pairs.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digestShape = /^[0-9a-f]{64}$/
const approvedReadiness = new Set(['NOT_READY_FOR_ADJUDICATION|EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'SOURCE_REQUIRES_REVIEW|CLASSIFICATION_REVIEW_REQUIRED', 'SOURCE_UNSUPPORTED|CLASSIFICATION_UNSUPPORTED'])

const conflict = (detail: string): DerivationResult => ({ ok: false, refusal: 'PROVENANCE_CONFLICT', detail })
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

function linksAgreeWithReason(item: CaseItemFacts): boolean {
  if (item.itemReasonCode === 'SOURCE_ONLY') return item.classificationId === null && item.readinessId === null
  if (item.itemReasonCode === 'CLASSIFIED_NO_READINESS') return item.classificationId !== null && uuidShape.test(item.classificationId) && item.readinessId === null
  if (item.itemReasonCode === 'LINKED') return item.classificationId !== null && uuidShape.test(item.classificationId) && item.readinessId !== null && uuidShape.test(item.readinessId)
  return false
}

export function deriveCasePrerequisite(header: CaseHeaderFacts, items: CaseItemFacts[], readiness: ReadinessFacts[]): DerivationResult {
  if (header.contractVersion !== PREREQ_CASE_CONTRACT) return conflict('the case is not an A7-REVENUE-CASE-1 snapshot')
  if (typeof header.manifestSha256 !== 'string' || !digestShape.test(header.manifestSha256)) return conflict('the case digest is not a lower-case SHA-256')
  if (![header.sourceCount, header.classifiedCount, header.readinessCount, header.itemCount].every(isCount)) return conflict('a case count is not a non-negative integer')
  if (header.sourceCount !== header.itemCount || items.length !== header.itemCount) return conflict('the case counts disagree with its recorded items')

  const sources = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (item.ordinal !== index + 1) return conflict('the case items are not numbered exactly 1..N')
    if (!uuidShape.test(item.sourceEvidenceId) || sources.has(item.sourceEvidenceId)) return conflict('a case item source is missing, not canonical or repeated')
    sources.add(item.sourceEvidenceId)
    if (!linksAgreeWithReason(item)) return conflict('a case item reason disagrees with its links')
  }
  const classified = items.filter((item) => item.classificationId !== null).length
  const linkedItems = items.filter((item) => item.itemReasonCode === 'LINKED')
  if (classified !== header.classifiedCount || linkedItems.length !== header.readinessCount) return conflict('the case counts disagree with its recorded links')

  const codeAgrees =
    (header.assemblyCode === 'NO_REVENUE_SOURCES' && header.itemCount === 0) ||
    (header.assemblyCode === 'INVENTORY_INCOMPLETE' && header.itemCount > 0 && linkedItems.length < header.itemCount) ||
    (header.assemblyCode === 'INVENTORY_COMPLETE' && header.itemCount > 0 && linkedItems.length === header.itemCount)
  if (!codeAgrees) return conflict('the case assembly code disagrees with its items')

  // Exactly one stored readiness for each linked item, and nothing else.
  const codes: string[] = []
  for (const item of linkedItems) {
    const stored = readiness.find((r) => r.readinessId === item.readinessId)
    if (!stored) return conflict('a linked readiness result is missing; it is never assumed ready')
    if (stored.classificationId !== item.classificationId || stored.sourceEvidenceId !== item.sourceEvidenceId) return conflict('a linked readiness result belongs to another classification or source')
    if (stored.contractVersion !== PREREQ_READINESS_CONTRACT) return conflict('a linked readiness result is under another contract version')
    if (!approvedReadiness.has(`${stored.readinessCode}|${stored.reasonCode}`)) return conflict('a linked readiness result is not an approved readiness/reason pair')
    codes.push(stored.readinessCode)
  }
  if (readiness.length !== linkedItems.length || new Set(readiness.map((r) => r.readinessId)).size !== readiness.length) return conflict('the stored readiness results do not match the linked items one to one')

  const assessmentCode: AssessmentCode =
    header.assemblyCode === 'NO_REVENUE_SOURCES'
      ? 'NO_SOURCE_BASIS'
      : header.assemblyCode === 'INVENTORY_INCOMPLETE'
        ? 'INCOMPLETE_SOURCE_CHAIN'
        : codes.includes('SOURCE_REQUIRES_REVIEW')
          ? 'REVIEW_REQUIRED'
          : codes.includes('SOURCE_UNSUPPORTED')
            ? 'UNSUPPORTED_SOURCE_BASIS'
            : 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'
  return { ok: true, value: { assessmentCode, basisCode: BASIS_OF[assessmentCode] } }
}

// §5 — a recorded assessment is the idempotent answer only when it agrees exactly with the derivation from its
// stored case (codes, copied digest, organization and contract); any difference is a conflict, and the recorded row
// is never rewritten.
export type AssessmentRecordFacts = { assessmentCode: string; basisCode: string; caseManifestSha256: string; organizationId: string; contractVersion: string }

export function recordedAssessmentAgrees(recorded: AssessmentRecordFacts, derived: AssessmentRecordFacts): boolean {
  return (
    recorded.assessmentCode === derived.assessmentCode &&
    recorded.basisCode === derived.basisCode &&
    recorded.caseManifestSha256 === derived.caseManifestSha256 &&
    recorded.organizationId === derived.organizationId &&
    recorded.contractVersion === derived.contractVersion
  )
}
