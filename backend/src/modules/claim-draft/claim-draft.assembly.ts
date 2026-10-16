import { createHash } from 'node:crypto'
import { Prisma } from '../../../generated/prisma/client.ts'
// A6.3 owns the pricing fingerprints. A6.4 calls its exported functions to compare a stored run with the
// current sources; it never matches rates, multiplies or rounds money itself.
import { lineFingerprint, runFingerprint, type LineEvaluation, type SourceFacts } from '../claim-pricing/claim-pricing.calculator.ts'
import { PRICING_CONTRACT_VERSION, type LineOutcome } from '../claim-pricing/claim-pricing.types.ts'
import { CLAIM_CONTRACT_VERSION } from '../claim/claim.types.ts'
import { claimDiagnosisRoles } from '../claim-diagnosis/claim-diagnosis.types.ts'
import { HANDOFF_SCHEMA_VERSION } from '../pre-claim-readiness/pre-claim-readiness.types.ts'
import { supportedCurrencyMinorUnits } from '../tariff-rate/tariff-rate.types.ts'
import {
  DRAFT_CONTRACT_VERSION,
  findingCatalogue,
  findingCodes,
  type DraftFinding,
  type DraftLineageDto,
  type DraftOutcome,
  type FindingCode,
} from './claim-draft.types.ts'

// A6.4 §4–§8 — the pure draft rules: claim-level completeness and structure, exact pricing coverage and
// lineage, drift against the A6.3 captured fingerprints, the deterministic finding order, the outcome
// reducer and the A6-DRAFT-1 assembly fingerprint. No database access, no clock, no JavaScript number for
// money, and no "latest" choice of anything.

// ---- the snapshot the service reads under one transaction -----------------------------------------

export type SnapshotSource = {
  encounterActivityId: string
  encounterId: string
  serviceId: string | null
  procedureCodeId: string | null
  quantity: Prisma.Decimal
  unitCode: string | null
  // In the activity's stored modifier order.
  modifierCodes: string[]
  removed: boolean
}

export type SnapshotLine = { id: string; sequence: number; sources: SnapshotSource[] }

export type SnapshotDiagnosis = {
  id: string
  sequence: number
  encounterDiagnosisId: string
  roleCode: string
  sourceEncounterId: string
  sourceRemoved: boolean
}

// Every ACTIVE pointer of an active line, with the claim and activity of the diagnosis it names.
export type SnapshotPointer = { id: string; claimLineId: string; claimDiagnosisId: string; diagnosisClaimId: string; diagnosisRemoved: boolean }

export type SnapshotPricingLine = {
  id: string
  claimLineId: string
  encounterActivityId: string
  lineSequenceAtEvaluation: number
  outcome: string
  tariffRateId: string | null
  unitTariffAmount: Prisma.Decimal | null
  quantityAtEvaluation: Prisma.Decimal
  extendedAmount: Prisma.Decimal | null
  currencyCode: string | null
  inputFingerprint: string
}

export type SnapshotPricing = {
  id: string
  claimId: string
  pricingContractVersion: string
  providerContractId: string
  tariffScheduleId: string
  tariffScheduleVersionId: string
  overallResult: string
  lineCount: number
  pricedCount: number
  currencyCode: string | null
  totalExtendedAmount: Prisma.Decimal | null
  inputStructureFingerprint: string
  lines: SnapshotPricingLine[]
}

// The A5.9 composer's answer on the same snapshot: the exact reference sets, or its refusal code.
export type SnapshotHandoff =
  | { ok: true; schemaVersion: string; readinessAssessmentId: string; encounterId: string; encounterActivityIds: ReadonlySet<string>; encounterDiagnosisIds: ReadonlySet<string> }
  | { ok: false; refusal: string }

export type DraftSnapshot = {
  lineage: DraftLineageDto
  claimEncounterId: string
  handoff: SnapshotHandoff
  lines: SnapshotLine[]
  diagnoses: SnapshotDiagnosis[]
  pointers: SnapshotPointer[]
  pricing: SnapshotPricing | null
}

// ---- findings ---------------------------------------------------------------------------------------

type RawFinding = { code: FindingCode; lineId?: string; diagnosisId?: string }

const isContiguous = (sequences: number[]) => [...sequences].sort((a, b) => a - b).every((sequence, index) => sequence === index + 1)

const firstOutOfOrder = <T extends { id: string; sequence: number }>(rows: T[]) =>
  [...rows].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)).find((row, index) => row.sequence !== index + 1)

// The pricing outcomes whose A6.3 line fingerprint can be rebuilt exactly from stored values: a PRICED
// line had exactly one candidate (its rate); a missing-rate or invalid-source line had none. An
// ambiguous or unsupported-currency line kept candidates A6.3 does not store, so only its quantity and
// removal are compared.
const reconstructableCandidates = (line: SnapshotPricingLine): string[] | null =>
  line.outcome === 'PRICED' && line.tariffRateId !== null ? [line.tariffRateId] : line.outcome === 'UNPRICED_RATE_MISSING' || line.outcome === 'UNPRICED_SOURCE_INVALID' ? [] : null

// §5 source drift — does the line's current source still produce the fingerprint A6.3 captured? The
// captured position is used, so a reorder is reported as structure drift, never as source drift.
export function sourceMatchesPricing(source: SnapshotSource, line: SnapshotPricingLine, tariffScheduleVersionId: string): boolean {
  const candidates = reconstructableCandidates(line)
  if (candidates === null) return !source.removed && source.quantity.toFixed(4) === line.quantityAtEvaluation.toFixed(4)
  const facts: SourceFacts = {
    claimLineId: line.claimLineId,
    sequence: line.lineSequenceAtEvaluation,
    encounterActivityId: source.encounterActivityId,
    serviceId: source.serviceId,
    procedureCodeId: source.procedureCodeId,
    quantity: source.quantity,
    unitCode: source.unitCode,
    modifierCodes: source.modifierCodes,
    removed: source.removed,
  }
  const evaluation: LineEvaluation = {
    claimLineId: line.claimLineId,
    encounterActivityId: line.encounterActivityId,
    sequence: line.lineSequenceAtEvaluation,
    outcome: line.outcome as LineOutcome,
    tariffRateId: line.tariffRateId,
    unitTariffAmount: line.unitTariffAmount,
    quantity: line.quantityAtEvaluation,
    extendedAmount: line.extendedAmount,
    currencyCode: line.currencyCode,
    candidateRateIds: candidates,
  }
  return lineFingerprint(facts, evaluation, tariffScheduleVersionId) === line.inputFingerprint
}

function lineFindings(snapshot: DraftSnapshot): RawFinding[] {
  const found: RawFinding[] = []
  const { lines, handoff } = snapshot
  if (lines.length === 0) found.push({ code: 'CLAIM_DRAFT_NO_LINES' })
  const outOfOrder = firstOutOfOrder(lines)
  if (outOfOrder) found.push({ code: 'CLAIM_DRAFT_ORDER_CORRUPT', lineId: outOfOrder.id })

  const carried = new Map<string, string>()
  for (const line of [...lines].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
    if (line.sources.length !== 1) {
      found.push({ code: 'CLAIM_DRAFT_LINE_SOURCE_INVALID', lineId: line.id })
      continue
    }
    const source = line.sources[0]
    const foreign = source.encounterId !== snapshot.claimEncounterId
    const outsideHandoff = handoff.ok && !handoff.encounterActivityIds.has(source.encounterActivityId)
    const duplicate = carried.has(source.encounterActivityId)
    if (foreign || outsideHandoff || duplicate) found.push({ code: 'CLAIM_DRAFT_LINE_SOURCE_INVALID', lineId: line.id })
    carried.set(source.encounterActivityId, line.id)
    if (source.removed) found.push({ code: 'CLAIM_DRAFT_SOURCE_STALE', lineId: line.id })
  }
  return found
}

function diagnosisFindings(snapshot: DraftSnapshot): RawFinding[] {
  const found: RawFinding[] = []
  const { diagnoses, handoff } = snapshot
  if (diagnoses.length === 0) found.push({ code: 'CLAIM_DRAFT_NO_DIAGNOSES' })
  const outOfOrder = firstOutOfOrder(diagnoses)
  if (outOfOrder) found.push({ code: 'CLAIM_DRAFT_ORDER_CORRUPT', diagnosisId: outOfOrder.id })

  const carried = new Set<string>()
  const roles = new Set<string>(claimDiagnosisRoles)
  for (const diagnosis of [...diagnoses].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))) {
    const foreign = diagnosis.sourceEncounterId !== snapshot.claimEncounterId
    const outsideHandoff = handoff.ok && !handoff.encounterDiagnosisIds.has(diagnosis.encounterDiagnosisId)
    if (foreign || outsideHandoff || carried.has(diagnosis.encounterDiagnosisId) || !roles.has(diagnosis.roleCode))
      found.push({ code: 'CLAIM_DRAFT_DIAGNOSIS_INVALID', diagnosisId: diagnosis.id })
    carried.add(diagnosis.encounterDiagnosisId)
    if (diagnosis.sourceRemoved) found.push({ code: 'CLAIM_DRAFT_SOURCE_STALE', diagnosisId: diagnosis.id })
    // §5 jurisdiction — whether an admitting diagnosis applies to this encounter is a governed
    // encounter-type rule A6-DRAFT-1 does not have, so it is reported as unsupported, never passed.
    if (diagnosis.roleCode === 'ADMITTING') found.push({ code: 'CLAIM_DRAFT_UNSUPPORTED_RULE', diagnosisId: diagnosis.id })
  }

  // §5 v1 — exactly one active PRIMARY. None is missing structure; several is a conflict, and no winner
  // is ever chosen among them.
  const primaries = diagnoses.filter((diagnosis) => diagnosis.roleCode === 'PRIMARY')
  if (diagnoses.length > 0 && primaries.length === 0) found.push({ code: 'CLAIM_DRAFT_PRIMARY_ROLE_MISSING' })
  if (primaries.length > 1) for (const primary of primaries) found.push({ code: 'CLAIM_DRAFT_PRIMARY_ROLE_MULTIPLE', diagnosisId: primary.id })
  return found
}

function pointerFindings(snapshot: DraftSnapshot): RawFinding[] {
  const found: RawFinding[] = []
  const activeDiagnoses = new Set(snapshot.diagnoses.map((diagnosis) => diagnosis.id))
  const seen = new Set<string>()
  const pointed = new Set<string>()
  for (const pointer of [...snapshot.pointers].sort((a, b) => a.claimLineId.localeCompare(b.claimLineId) || a.claimDiagnosisId.localeCompare(b.claimDiagnosisId) || a.id.localeCompare(b.id))) {
    const pair = `${pointer.claimLineId}/${pointer.claimDiagnosisId}`
    const corrupt = pointer.diagnosisClaimId !== snapshot.lineage.claimId || pointer.diagnosisRemoved || !activeDiagnoses.has(pointer.claimDiagnosisId) || seen.has(pair)
    if (corrupt) found.push({ code: 'CLAIM_DRAFT_POINTER_CORRUPT', lineId: pointer.claimLineId, diagnosisId: pointer.claimDiagnosisId })
    else pointed.add(pointer.claimLineId)
    seen.add(pair)
  }
  // §5 v1 — every active line points to at least one active diagnosis of its own Claim.
  for (const line of snapshot.lines) if (!pointed.has(line.id)) found.push({ code: 'CLAIM_DRAFT_LINE_DIAGNOSIS_MISSING', lineId: line.id })
  return found
}

function pricingFindings(snapshot: DraftSnapshot): RawFinding[] {
  const { pricing, lineage } = snapshot
  if (pricing === null) return [{ code: 'CLAIM_DRAFT_PRICING_RUN_MISSING' }]
  const found: RawFinding[] = []

  // §5 historical commercial linkage — the run must price exactly the contract, schedule and version the
  // Claim's bound ValidationRun recorded. A null identity fails closed.
  if (
    lineage.providerContractId === null ||
    lineage.tariffScheduleId === null ||
    lineage.tariffScheduleVersionId === null ||
    pricing.providerContractId !== lineage.providerContractId ||
    pricing.tariffScheduleId !== lineage.tariffScheduleId ||
    pricing.tariffScheduleVersionId !== lineage.tariffScheduleVersionId
  )
    found.push({ code: 'CLAIM_DRAFT_COMMERCIAL_MISMATCH' })

  // §4 step 5 — the stored run must be internally whole: its contract, its declared counts, one result
  // per line, a total and a configured currency when PRICED, and the run fingerprint A6.3 derived from
  // its own line fingerprints. Nothing is recomputed from money.
  const ordered = [...pricing.lines].sort((a, b) => a.lineSequenceAtEvaluation - b.lineSequenceAtEvaluation || a.claimLineId.localeCompare(b.claimLineId))
  const pricedLines = ordered.filter((line) => line.outcome === 'PRICED')
  const resultLineIds = new Set(ordered.map((line) => line.claimLineId))
  const wholeRun =
    pricing.claimId === lineage.claimId &&
    pricing.pricingContractVersion === PRICING_CONTRACT_VERSION &&
    ordered.length === pricing.lineCount &&
    pricedLines.length === pricing.pricedCount &&
    resultLineIds.size === ordered.length &&
    isContiguous(ordered.map((line) => line.lineSequenceAtEvaluation)) &&
    runFingerprint(pricing.claimId, pricing.tariffScheduleVersionId, ordered.map((line) => line.inputFingerprint)) === pricing.inputStructureFingerprint &&
    (pricing.overallResult === 'INCOMPLETE' ||
      (pricing.overallResult === 'PRICED' &&
        pricing.totalExtendedAmount !== null &&
        pricing.currencyCode !== null &&
        supportedCurrencyMinorUnits[pricing.currencyCode] !== undefined &&
        pricedLines.length === ordered.length &&
        pricedLines.every((line) => line.currencyCode === pricing.currencyCode && line.extendedAmount !== null)))
  if (!wholeRun) found.push({ code: 'CLAIM_DRAFT_PRICING_INTEGRITY' })
  if (pricing.overallResult !== 'PRICED') found.push({ code: 'CLAIM_DRAFT_PRICING_INCOMPLETE' })

  // §5 exact line coverage — one result for each active line, none for a line no longer active. Any
  // difference means the run priced a different structure: the run is stale, never re-priced.
  const activeById = new Map(snapshot.lines.map((line) => [line.id, line]))
  for (const line of snapshot.lines) if (!resultLineIds.has(line.id)) found.push({ code: 'CLAIM_DRAFT_PRICING_STALE', lineId: line.id })
  for (const result of ordered) {
    const line = activeById.get(result.claimLineId)
    if (!line) {
      found.push({ code: 'CLAIM_DRAFT_PRICING_STALE', lineId: result.claimLineId })
      continue
    }
    if (line.sources.length !== 1 || line.sources[0].encounterActivityId !== result.encounterActivityId) {
      found.push({ code: 'CLAIM_DRAFT_PRICING_INTEGRITY', lineId: line.id })
      continue
    }
    // §5 structure drift — the same lines in a different order: the money may be unchanged, but the
    // review context the run captured is not the current one.
    if (line.sequence !== result.lineSequenceAtEvaluation) found.push({ code: 'CLAIM_DRAFT_STRUCTURE_STALE', lineId: line.id })
    if (!sourceMatchesPricing(line.sources[0], result, pricing.tariffScheduleVersionId)) found.push({ code: 'CLAIM_DRAFT_SOURCE_STALE', lineId: line.id })
  }
  return found
}

function handoffFindings(snapshot: DraftSnapshot): RawFinding[] {
  const { handoff, lineage } = snapshot
  const coherent =
    handoff.ok &&
    lineage.claimContractVersion === CLAIM_CONTRACT_VERSION &&
    lineage.handoffSchemaVersion === HANDOFF_SCHEMA_VERSION &&
    handoff.schemaVersion === lineage.handoffSchemaVersion &&
    handoff.readinessAssessmentId === lineage.readinessAssessmentId &&
    handoff.encounterId === snapshot.claimEncounterId
  return coherent ? [] : [{ code: 'CLAIM_DRAFT_HANDOFF_INVALID' }]
}

// ---- order, reduction and the evaluation entry point -----------------------------------------------

const codeRank = new Map(findingCodes.map((code, index) => [code, index]))
const LAST = Number.MAX_SAFE_INTEGER

// §8 — one deterministic order: catalogue order, then the current line position, then the current
// diagnosis position, then identifiers. Database order and request order never matter. Exact duplicates
// (the same code about the same rows) are reported once.
export function orderFindings(raw: RawFinding[], snapshot: Pick<DraftSnapshot, 'lines' | 'diagnoses'>): DraftFinding[] {
  const lineSequence = new Map(snapshot.lines.map((line) => [line.id, line.sequence]))
  const diagnosisSequence = new Map(snapshot.diagnoses.map((diagnosis) => [diagnosis.id, diagnosis.sequence]))
  const unique = new Map<string, RawFinding>()
  for (const finding of raw) unique.set(`${finding.code}|${finding.lineId ?? ''}|${finding.diagnosisId ?? ''}`, finding)
  return [...unique.values()]
    .sort(
      (a, b) =>
        (codeRank.get(a.code) ?? LAST) - (codeRank.get(b.code) ?? LAST) ||
        (a.lineId ? (lineSequence.get(a.lineId) ?? LAST) : 0) - (b.lineId ? (lineSequence.get(b.lineId) ?? LAST) : 0) ||
        (a.diagnosisId ? (diagnosisSequence.get(a.diagnosisId) ?? LAST) : 0) - (b.diagnosisId ? (diagnosisSequence.get(b.diagnosisId) ?? LAST) : 0) ||
        (a.lineId ?? '').localeCompare(b.lineId ?? '') ||
        (a.diagnosisId ?? '').localeCompare(b.diagnosisId ?? ''),
    )
    .map((finding, index) => {
      const entry = findingCatalogue[finding.code]
      return {
        ordinal: index + 1,
        findingCode: finding.code,
        severity: entry.class === 'ADVISORY' ? 'ADVISORY' : 'BLOCKER',
        ownerScope: entry.scope,
        relatedClaimLineId: finding.lineId ?? null,
        relatedClaimDiagnosisId: finding.diagnosisId ?? null,
      }
    })
}

const precedence: DraftOutcome[] = ['INVALID', 'STALE', 'INCOMPLETE']

// §3 — INVALID > STALE > INCOMPLETE > REVIEWABLE. ADVISORY findings never change the outcome.
export function reduceOutcome(findings: Pick<DraftFinding, 'findingCode'>[]): DraftOutcome {
  const classes = new Set<string>(findings.map((finding) => findingCatalogue[finding.findingCode].class))
  return precedence.find((outcome) => classes.has(outcome)) ?? 'REVIEWABLE'
}

export function evaluateDraft(snapshot: DraftSnapshot): { outcome: DraftOutcome; findings: DraftFinding[] } {
  const raw = [
    ...handoffFindings(snapshot),
    ...lineFindings(snapshot),
    ...diagnosisFindings(snapshot),
    ...pointerFindings(snapshot),
    ...pricingFindings(snapshot),
    // §5 — the minimal structural checks never establish DHA/eClaimLink or payer coding compliance; every
    // draft says so explicitly instead of implying a pass.
    { code: 'CLAIM_DRAFT_JURISDICTION_RULES_NOT_EVALUATED' as const },
  ]
  const findings = orderFindings(raw, snapshot)
  return { outcome: reduceOutcome(findings), findings }
}

// ---- §7 the versioned canonical assembly fingerprint ------------------------------------------------

// Canonical JSON: object keys sorted by code point, arrays kept in their defined order, only strings,
// integers, booleans and null. A float, undefined or any other value is a programming error, never
// silently serialized.
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: only safe integers are allowed')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  throw new Error('canonicalJson: unsupported value')
}

const decimalText = (value: Prisma.Decimal | null) => (value === null ? null : value.toFixed(4))

// The fingerprint input: stable identities and canonical values relevant to review. No display name,
// clock time, database order, human text or JavaScript float.
export function assemblyInput(snapshot: DraftSnapshot) {
  const { lineage, pricing } = snapshot
  return {
    contract: DRAFT_CONTRACT_VERSION,
    claimId: lineage.claimId,
    claimContractVersion: lineage.claimContractVersion,
    handoffSchemaVersion: lineage.handoffSchemaVersion,
    readinessAssessmentId: lineage.readinessAssessmentId,
    validationRunId: lineage.validationRunId,
    serviceDate: lineage.serviceDate,
    facilityRegulatoryProfileId: lineage.facilityRegulatoryProfileId,
    providerContractId: lineage.providerContractId,
    tariffScheduleId: lineage.tariffScheduleId,
    tariffScheduleVersionId: lineage.tariffScheduleVersionId,
    lines: [...snapshot.lines]
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
      .map((line) => ({
        claimLineId: line.id,
        sequence: line.sequence,
        sources: [...line.sources]
          .sort((a, b) => a.encounterActivityId.localeCompare(b.encounterActivityId))
          .map((source) => ({
            encounterActivityId: source.encounterActivityId,
            serviceId: source.serviceId,
            procedureCodeId: source.procedureCodeId,
            quantity: source.quantity.toFixed(4),
            unitCode: source.unitCode,
            modifierCodes: source.modifierCodes,
            removed: source.removed,
          })),
      })),
    diagnoses: [...snapshot.diagnoses]
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
      .map((diagnosis) => ({ claimDiagnosisId: diagnosis.id, sequence: diagnosis.sequence, encounterDiagnosisId: diagnosis.encounterDiagnosisId, roleCode: diagnosis.roleCode, sourceRemoved: diagnosis.sourceRemoved })),
    // A set: sorted, so request and database order never change the fingerprint.
    pointers: snapshot.pointers
      .map((pointer) => [pointer.claimLineId, pointer.claimDiagnosisId])
      .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])),
    pricing:
      pricing === null
        ? null
        : {
            pricingRunId: pricing.id,
            pricingContractVersion: pricing.pricingContractVersion,
            inputStructureFingerprint: pricing.inputStructureFingerprint,
            overallResult: pricing.overallResult,
            currencyCode: pricing.currencyCode,
            totalExtendedAmount: decimalText(pricing.totalExtendedAmount),
            lines: [...pricing.lines]
              .sort((a, b) => a.lineSequenceAtEvaluation - b.lineSequenceAtEvaluation || a.claimLineId.localeCompare(b.claimLineId))
              .map((line) => ({ pricingLineResultId: line.id, claimLineId: line.claimLineId, outcome: line.outcome, extendedAmount: decimalText(line.extendedAmount) })),
          },
  }
}

// Explicit version prefix + canonical JSON (UTF-8) + SHA-256. An integrity comparator only: it is not
// the A6.6 canonical payload and not the A6.7 submission hash.
export function assemblyFingerprint(snapshot: DraftSnapshot): string {
  return createHash('sha256').update(`${DRAFT_CONTRACT_VERSION}\n${canonicalJson(assemblyInput(snapshot))}`, 'utf8').digest('hex')
}
