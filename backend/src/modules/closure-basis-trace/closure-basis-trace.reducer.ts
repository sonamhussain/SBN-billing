import { CASE_CONTRACT_VERSION } from '../evidence-case/evidence-case.types.ts'
import { READINESS_CONTRACT_VERSION } from '../evidence-gate/evidence-gate.types.ts'
import { BASIS_OF, PREREQ_CONTRACT_VERSION, assessmentCodes } from '../case-prerequisite/case-prerequisite.types.ts'
import type { ExplanationCode, TraceCode, TraceFacts, TraceItem, TraceResult } from './closure-basis-trace.types.ts'

// A7.6 §3 — the one pure, deterministic explanation reducer. It reads the STORED A7.5 assessment, the STORED A7.4
// header and entries, the STORED A7.3 results of the linked entries and the A7.1 registration ids of the frozen
// submission. It never re-assembles the case, recomputes its manifest, re-classifies, re-derives a readiness or
// re-runs the A7.5 assessment: it explains each stored item, names the outcome those explanations support, and
// requires that outcome and its basis to be exactly the ones A7.5 recorded. No clock, locale, time zone,
// environment, database, network, randomness or money is read.
//
// Fail closed (a provenance conflict, nothing explained) on any disagreement: another A7.5, A7.4 or A7.3 contract;
// an assessment of another case or organization, or with an uncontrolled code, a basis that is not its code's or
// a digest that is not the case's; counts that disagree with each other or with the entries; ordinals that are not
// exactly 1..N; a repeated source or a source that is not the frozen submission's; a reason that disagrees with its
// links; an assembly code that disagrees with the entries; a linked readiness that is missing, duplicated, of
// another source, classification or contract, or not an approved readiness/reason pair; or an explained outcome that
// is not the recorded one.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const digestShape = /^[0-9a-f]{64}$/
const explanationOfReadiness = new Map<string, ExplanationCode>([
  ['NOT_READY_FOR_ADJUDICATION|EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT'],
  ['SOURCE_REQUIRES_REVIEW|CLASSIFICATION_REVIEW_REQUIRED', 'CLASSIFICATION_REVIEW_REQUIRED'],
  ['SOURCE_UNSUPPORTED|CLASSIFICATION_UNSUPPORTED', 'CLASSIFICATION_UNSUPPORTED'],
])

const conflict = (detail: string): TraceResult => ({ ok: false, refusal: 'PROVENANCE_CONFLICT', detail })
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isControlledCode = (value: string): value is TraceCode => (assessmentCodes as readonly string[]).includes(value)

function linksAgreeWithReason(entry: TraceFacts['entries'][number]): boolean {
  if (entry.itemReasonCode === 'SOURCE_ONLY') return entry.classificationId === null && entry.readinessId === null
  if (entry.itemReasonCode === 'CLASSIFIED_NO_READINESS') return entry.classificationId !== null && uuidShape.test(entry.classificationId) && entry.readinessId === null
  if (entry.itemReasonCode === 'LINKED') return entry.classificationId !== null && uuidShape.test(entry.classificationId) && entry.readinessId !== null && uuidShape.test(entry.readinessId)
  return false
}

// The outcome a set of item explanations supports, in the A7.5 priority: no item, any missing link, any review, any
// unsupported, otherwise external financial evidence absent.
function outcomeOfExplanations(explanations: ExplanationCode[]): TraceCode {
  if (explanations.length === 0) return 'NO_SOURCE_BASIS'
  if (explanations.some((code) => code === 'SOURCE_UNCLASSIFIED' || code === 'CLASSIFICATION_NO_READINESS')) return 'INCOMPLETE_SOURCE_CHAIN'
  if (explanations.includes('CLASSIFICATION_REVIEW_REQUIRED')) return 'REVIEW_REQUIRED'
  if (explanations.includes('CLASSIFICATION_UNSUPPORTED')) return 'UNSUPPORTED_SOURCE_BASIS'
  return 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT'
}

export function traceClosureBasis(facts: TraceFacts): TraceResult {
  const { assessment, header, entries, readiness } = facts

  // The exact A7.5 assessment of exactly this case.
  if (assessment.contractVersion !== PREREQ_CONTRACT_VERSION) return conflict('the assessment is not an A7-CLOSURE-PREREQ-1 record')
  if (assessment.caseId !== header.caseId) return conflict('the assessment names another case')
  if (assessment.organizationId !== header.organizationId) return conflict('the assessment and its case belong to different organizations')
  if (!isControlledCode(assessment.assessmentCode)) return conflict('the assessment code is not a controlled outcome')
  if (assessment.basisCode !== BASIS_OF[assessment.assessmentCode]) return conflict('the assessment basis is not the basis of its outcome')
  if (typeof header.manifestSha256 !== 'string' || !digestShape.test(header.manifestSha256)) return conflict('the case digest is not a lower-case SHA-256')
  if (assessment.caseManifestSha256 !== header.manifestSha256) return conflict('the assessment digest is not the case digest')

  // The exact A7.4 case: contract, counts, ordered entries, link shapes and assembly code.
  if (header.contractVersion !== CASE_CONTRACT_VERSION) return conflict('the case is not an A7-REVENUE-CASE-1 snapshot')
  if (![header.sourceCount, header.classifiedCount, header.readinessCount, header.itemCount].every(isCount)) return conflict('a case count is not a non-negative integer')
  if (header.sourceCount !== header.itemCount || entries.length !== header.itemCount) return conflict('the case counts disagree with its stored entries')
  const registered = new Set(facts.submissionSourceIds)
  const sources = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    if (entry.ordinal !== index + 1) return conflict('the case entries are not numbered exactly 1..N')
    if (!uuidShape.test(entry.sourceEvidenceId) || sources.has(entry.sourceEvidenceId)) return conflict('a case entry source is missing, not canonical or repeated')
    if (!registered.has(entry.sourceEvidenceId)) return conflict("a case entry source is not a registration of the case's frozen submission")
    sources.add(entry.sourceEvidenceId)
    if (!linksAgreeWithReason(entry)) return conflict('a case entry reason disagrees with its links')
  }
  const linked = entries.filter((entry) => entry.itemReasonCode === 'LINKED')
  if (entries.filter((entry) => entry.classificationId !== null).length !== header.classifiedCount || linked.length !== header.readinessCount) return conflict('the case counts disagree with its stored links')
  const codeAgrees =
    (header.assemblyCode === 'NO_REVENUE_SOURCES' && header.itemCount === 0) ||
    (header.assemblyCode === 'INVENTORY_INCOMPLETE' && header.itemCount > 0 && linked.length < header.itemCount) ||
    (header.assemblyCode === 'INVENTORY_COMPLETE' && header.itemCount > 0 && linked.length === header.itemCount)
  if (!codeAgrees) return conflict('the case assembly code disagrees with its entries')

  // The stored A7.3 results: exactly one per linked classification, the one the entry names, and nothing else.
  const linkedClassifications = new Set(linked.map((entry) => entry.classificationId))
  if (readiness.some((result) => !linkedClassifications.has(result.classificationId))) return conflict('a readiness result belongs to no linked entry')
  if (new Set(linked.map((entry) => entry.readinessId)).size !== linked.length) return conflict('two linked entries name the same readiness result')
  const traceItems: TraceItem[] = []
  for (const entry of entries) {
    const base = { ordinal: entry.ordinal, sourceEvidenceId: entry.sourceEvidenceId, classificationId: entry.classificationId, readinessId: entry.readinessId, sourceReasonCode: entry.itemReasonCode }
    if (entry.itemReasonCode === 'SOURCE_ONLY') {
      traceItems.push({ ...base, readinessCode: null, readinessReasonCode: null, explanationCode: 'SOURCE_UNCLASSIFIED' })
      continue
    }
    if (entry.itemReasonCode === 'CLASSIFIED_NO_READINESS') {
      traceItems.push({ ...base, readinessCode: null, readinessReasonCode: null, explanationCode: 'CLASSIFICATION_NO_READINESS' })
      continue
    }
    const stored = readiness.filter((result) => result.classificationId === entry.classificationId)
    if (stored.length === 0) return conflict('a linked readiness result is missing; it is never assumed')
    if (stored.length > 1) return conflict('more than one readiness result exists for a linked classification')
    const result = stored[0]
    if (result.readinessId !== entry.readinessId) return conflict('a linked entry names another readiness result than its classification has')
    if (result.sourceEvidenceId !== entry.sourceEvidenceId) return conflict('a linked readiness result belongs to another source')
    if (result.contractVersion !== READINESS_CONTRACT_VERSION) return conflict('a linked readiness result is under another contract version')
    const explanationCode = explanationOfReadiness.get(`${result.readinessCode}|${result.reasonCode}`)
    if (!explanationCode) return conflict('a linked readiness result is not an approved readiness/reason pair')
    traceItems.push({ ...base, readinessCode: result.readinessCode, readinessReasonCode: result.reasonCode, explanationCode })
  }

  // The explanations must support exactly the outcome A7.5 recorded; never a replacement for it.
  const traceCode = outcomeOfExplanations(traceItems.map((item) => item.explanationCode))
  if (traceCode !== assessment.assessmentCode) return conflict('the stored items do not explain the recorded outcome')
  return { ok: true, value: { traceCode, traceItems } }
}
