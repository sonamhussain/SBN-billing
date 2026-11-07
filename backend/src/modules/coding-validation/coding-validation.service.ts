import { createHash } from 'node:crypto'
import { Prisma } from '../../../generated/prisma/client.ts'
import { prisma } from '../../shared/database/prisma.ts'
import type { DbClient } from '../../shared/database/database.types.ts'
import { withReadSnapshot } from '../../shared/database/read-snapshot.ts'
import { formatDateOnly } from '../../shared/rules/date-only.ts'
import { readTransactionTimestamp } from '../encounter-billing-context/encounter-billing-context.repository.ts'
// Checkpoint A is the edition authority, consulted on the caller's transaction and never duplicated.
import { getCodingReleaseCheckOf } from '../coding-release/coding-release.service.ts'
import { codingReleasePlans, manifestOf, selectValidator, type TargetMaster } from './coding-validation.manifest.ts'
import {
  findCodingFindingsOfRun,
  findLatestScopeDecision,
  findManifestOfRun,
  findMappingsOfDatasets,
  findReceiptsOfRun,
  findReleaseRows,
  findRunForVerification,
  findScopeOfProfile,
  findSubmissionForProvenance,
  findTargetMasters,
  insertManifest,
  insertReceipts,
  insertScopeDecision,
} from './coding-validation.repository.ts'
import {
  type CodingReceiptDto,
  type CodingReceiptManifestDto,
  type CodingValidationResult,
  codingReleaseFindings,
  type ReceiptPlan,
  RECEIPT_CONTRACT_VERSION,
  type RunCodingReceiptsDto,
  type SubmissionCodingProvenanceDto,
  type ValidatorSelection,
} from './coding-validation.types.ts'

// CRG-01 FINAL Checkpoint B — what A5.8 consults for the validator selection and the A5-VAL-2 coding check, how the
// receipts and manifest of an A5-VAL-2 run are written on A5.8's own transaction, and the verification of recorded
// receipts. The verification reads only immutable records (design freeze 1.2 §10, H1–H5): it never re-runs the
// resolver, and never reads current rights, activation, retirement, a later edition, the encounter's current target
// activity or the current A2 masters.

// A defect that must abort the caller's whole transaction (nothing is committed).
export class CodingValidationIntegrityDefect extends Error {}

const conflict = (message: string): CodingValidationResult<never> => ({ ok: false, code: 'CODING_RECEIPT_INTEGRITY_CONFLICT', message })

// ---- selection and the A5-VAL-2 coding check (on A5.8's transaction) -----------------------------------------

export async function selectValidatorForProfile(profileId: string, tx: DbClient): Promise<ValidatorSelection> {
  return selectValidator(await findScopeOfProfile(profileId, tx))
}

export type CodingReleaseDraft = {
  findingCode: string
  outcome: 'PASS' | 'FAIL'
  message: string
  encounterDiagnosisId: string | null
  encounterActivityId: string | null
  referenceDatasetVersionId: string | null
}

// One coding-release finding draft and one receipt plan per required target, from the Checkpoint A answer on the same
// snapshot. A Checkpoint A integrity refusal is an integrity defect of the run (no run is written).
export async function evaluateCodingRelease(encounterId: string, tx: DbClient): Promise<{ drafts: CodingReleaseDraft[]; plans: ReceiptPlan[] }> {
  const check = await getCodingReleaseCheckOf(encounterId, tx)
  if (!check.ok) throw new CodingValidationIntegrityDefect(`the coding-release check refused: ${check.code}`)
  const masters = new Map<string, TargetMaster>((await findTargetMasters(encounterId, tx)).map((row) => [row.targetId, row]))
  const datasets = [...new Set(check.value.items.flatMap((item) => (item.edition ? [item.edition.datasetId] : [])))]
  const planned = codingReleasePlans(check.value, masters, await findMappingsOfDatasets(datasets, tx))
  if (!planned.ok) throw new CodingValidationIntegrityDefect(planned.detail)
  return { drafts: planned.value.map((entry) => entry.finding), plans: planned.value.map((entry) => entry.plan) }
}

// After A5.7 recorded the run: bind each plan to its recorded finding (same target, same finding code), write the
// receipts, then the manifest. The deferred guards prove I1–I6 at commit.
export async function recordCodingReceipts(runId: string, encounterId: string, plans: readonly ReceiptPlan[], tx: DbClient): Promise<{ receiptCount: number; manifestSha256: string }> {
  const findings = (await findCodingFindingsOfRun(runId, tx)).filter((row) => row.findingCode.startsWith('CODING_RELEASE_'))
  const bound = plans.map((plan) => {
    const code = codingReleaseFindings[plan.decisionCode].findingCode
    const matches = findings.filter((row) => row.findingCode === code && (plan.subjectKind === 'DIAGNOSIS' ? row.encounterDiagnosisId === plan.targetId : row.encounterActivityId === plan.targetId))
    if (matches.length !== 1) throw new CodingValidationIntegrityDefect('a coding-release finding could not be bound to exactly one receipt')
    return { ...plan, validationFindingId: matches[0].id }
  })
  if (bound.length !== findings.length) throw new CodingValidationIntegrityDefect('the coding-release findings and receipts are not one to one')
  await insertReceipts(runId, encounterId, bound, tx)
  const manifest = manifestOf(bound)
  await insertManifest(runId, manifest.receiptCount, manifest.manifestSha256, tx)
  return manifest
}

// ---- verification as recorded (H1–H4; H5 is the freeze's) ----------------------------------------------------

const findingCodeOf: Record<string, string> = Object.fromEntries(Object.entries(codingReleaseFindings).map(([decision, entry]) => [decision, entry.findingCode]))
const norm = (value: string) => value.trim().toUpperCase()

export type VerifiedReceipts = { validationRunId: string; encounterId: string; organizationId: string; manifest: CodingReceiptManifestDto }

// The receipts of an A5-VAL-2 run, verified against immutable records only. Answers the receipts or the first broken
// condition; never repairs, never re-resolves.
export async function verifyReceiptsAsRecorded(runId: string, tx: DbClient): Promise<CodingValidationResult<VerifiedReceipts>> {
  const run = await findRunForVerification(runId, tx)
  if (!run) return { ok: false, code: 'NOT_FOUND', message: 'validation run not found' }
  if (run.validatorVersion !== 'A5-VAL-2') return conflict('the run is not an A5-VAL-2 run')
  const [receipts, manifest, findings] = await Promise.all([findReceiptsOfRun(runId, tx), findManifestOfRun(runId, tx), findCodingFindingsOfRun(runId, tx)])
  // H1 — the manifest exists and its count and digest are those of exactly these receipts.
  if (!manifest) return conflict('H1: the run has no receipt manifest')
  const recomputed = manifestOf(
    receipts.map((r) => ({
      subjectKind: r.subjectKind,
      targetId: (r.encounterDiagnosisId ?? r.encounterActivityId) as string,
      validationFindingId: r.validationFindingId,
      masterCodeId: r.masterCodeId,
      codeSystem: r.codeSystem,
      canonicalCode: r.canonicalCode,
      decisionCode: r.decisionCode,
      codeSystemDatasetId: r.codeSystemDatasetId,
      releaseImportId: r.releaseImportId,
      referenceDatasetVersionId: r.referenceDatasetVersionId,
      membershipId: r.membershipId,
      sourceRowSha256: r.sourceRowSha256,
    })),
  )
  if (recomputed.receiptCount !== manifest.receiptCount || recomputed.manifestSha256 !== manifest.manifestSha256) return conflict('H1: the manifest count or digest differs from the receipts')
  // H2 — one finding of the same run per receipt, with the same target, mapped code and edition; and one receipt per
  // coding-release finding.
  const findingById = new Map(findings.map((row) => [row.id, row]))
  for (const r of receipts) {
    const f = findingById.get(r.validationFindingId)
    if (
      !f ||
      f.findingCode !== findingCodeOf[r.decisionCode] ||
      f.encounterDiagnosisId !== r.encounterDiagnosisId ||
      f.encounterActivityId !== r.encounterActivityId ||
      f.referenceDatasetVersionId !== r.referenceDatasetVersionId ||
      r.encounterId !== run.encounterId
    )
      return conflict('H2: a receipt does not explain a coding finding of its run')
  }
  const explained = new Set(receipts.map((r) => r.validationFindingId))
  if (findings.some((f) => f.findingCode.startsWith('CODING_RELEASE_') && !explained.has(f.id))) return conflict('H2: a coding-release finding has no receipt')
  // H3 — each recorded release identity still resolves to the same append-only Checkpoint A rows.
  const rows = await findReleaseRows(receipts, tx)
  for (const r of receipts) {
    if (r.membershipId) {
      const m = rows.memberships.get(r.membershipId)
      if (!m || m.datasetVersionId !== r.referenceDatasetVersionId || m.importId !== r.releaseImportId || m.codeSystem !== r.codeSystem || m.code !== r.canonicalCode || m.sourceRowSha256 !== r.sourceRowSha256 || m.releaseContentHash !== r.releaseContentHash)
        return conflict('H3: a receipt membership does not match its recorded release row')
    }
    if (r.referenceDatasetVersionId) {
      const v = rows.versions.get(r.referenceDatasetVersionId)
      const i = r.releaseImportId ? rows.imports.get(r.releaseImportId) : undefined
      const map = r.codeSystemDatasetId ? rows.mappings.get(r.codeSystemDatasetId) : undefined
      if (!v || !i || !map) return conflict('H3: a receipt names a release row that does not exist')
      if (i.datasetVersionId !== v.id || i.codeSystem !== r.codeSystem || i.membershipFingerprintSha256 !== r.membershipFingerprintSha256) return conflict('H3: a receipt import does not match its edition')
      if (map.datasetId !== v.datasetId || map.codeSystem !== r.codeSystem || norm(map.jurisdictionCode) !== r.jurisdictionCode || norm(map.authorityCode) !== r.authorityCode)
        return conflict('H3: a receipt dataset mapping does not match its edition or scope')
      if (norm(map.dataset.jurisdictionCode) !== r.jurisdictionCode || norm(map.dataset.authorityCode) !== r.authorityCode) return conflict('H3: a receipt dataset is of another scope')
      if (r.releaseContentHash !== null && r.releaseContentHash !== v.contentHash) return conflict('H3: a receipt release hash differs from its edition')
    }
  }
  // H4 — the recorded scope and service date are those of the run.
  const runDate = formatDateOnly(run.serviceDate)
  const scope = { jurisdictionCode: norm(run.facilityRegulatoryProfile.jurisdictionCode), authorityCode: norm(run.facilityRegulatoryProfile.regulatoryAuthorityCode) }
  if (receipts.some((r) => formatDateOnly(r.serviceDate) !== runDate || r.jurisdictionCode !== scope.jurisdictionCode || r.authorityCode !== scope.authorityCode))
    return conflict("H4: a receipt's scope or service date differs from its run")

  const dtos: CodingReceiptDto[] = receipts
    .map((r) => ({
      receiptId: r.id,
      subjectKind: r.subjectKind,
      targetId: (r.encounterDiagnosisId ?? r.encounterActivityId) as string,
      findingId: r.validationFindingId,
      masterCodeId: r.masterCodeId,
      decisionCode: r.decisionCode,
      codeSystem: r.codeSystem,
      codeSystemDatasetId: r.codeSystemDatasetId,
      releaseImportId: r.releaseImportId,
      referenceDatasetVersionId: r.referenceDatasetVersionId,
      membershipId: r.membershipId,
    }))
    .sort((a, b) => (a.subjectKind < b.subjectKind ? -1 : a.subjectKind > b.subjectKind ? 1 : a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0))
  return {
    ok: true,
    value: {
      validationRunId: run.id,
      encounterId: run.encounterId,
      organizationId: run.encounter.patient.organizationId,
      manifest: { manifestId: manifest.id, manifestSha256: manifest.manifestSha256, receiptCount: manifest.receiptCount, receipts: dtos },
    },
  }
}

// ---- read routes (READ ONLY snapshots) -----------------------------------------------------------------------

export async function getRunCodingReceiptsOf(runId: string, tx: DbClient): Promise<CodingValidationResult<RunCodingReceiptsDto>> {
  const run = await findRunForVerification(runId, tx)
  if (!run) return { ok: false, code: 'NOT_FOUND', message: 'validation run not found' }
  const evaluatedAt = (await readTransactionTimestamp(tx)).toISOString()
  if (run.validatorVersion !== 'A5-VAL-2') return { ok: true, value: { contractVersion: RECEIPT_CONTRACT_VERSION, validationRunId: run.id, validatorVersion: run.validatorVersion, verificationStatus: 'LEGACY_PROVENANCE_UNVERIFIED', manifest: null, evaluatedAt } }
  const verified = await verifyReceiptsAsRecorded(runId, tx)
  if (!verified.ok) return verified
  return { ok: true, value: { contractVersion: RECEIPT_CONTRACT_VERSION, validationRunId: run.id, validatorVersion: run.validatorVersion, verificationStatus: 'VERIFIED_AS_RECORDED', manifest: verified.value.manifest, evaluatedAt } }
}

export async function getRunCodingReceipts(runId: string) {
  return withReadSnapshot(undefined, (tx) => getRunCodingReceiptsOf(runId, tx))
}

// H5 — a V2 freeze's frozen bytes, their SHA-256 and the payload's coding section equal the recorded receipts.
export type FrozenCodingSection = { manifestSha256: string; receiptIds: string[] }
export const readFrozenCodingSection = (bytes: Uint8Array): FrozenCodingSection | null => {
  try {
    const payload = JSON.parse(Buffer.from(bytes).toString('utf8')) as { coding?: { manifestSha256?: unknown; diagnoses?: { receiptId?: unknown }[]; lines?: { receiptId?: unknown }[] } }
    const coding = payload.coding
    if (!coding || typeof coding.manifestSha256 !== 'string' || !Array.isArray(coding.diagnoses) || !Array.isArray(coding.lines)) return null
    const receiptIds = [...coding.diagnoses, ...coding.lines].map((entry) => entry.receiptId)
    if (!receiptIds.every((id): id is string => typeof id === 'string')) return null
    return { manifestSha256: coding.manifestSha256, receiptIds }
  } catch {
    return null
  }
}

export async function getSubmissionCodingProvenanceOf(submissionId: string, tx: DbClient): Promise<CodingValidationResult<SubmissionCodingProvenanceDto>> {
  const freeze = await findSubmissionForProvenance(submissionId, tx)
  if (!freeze) return { ok: false, code: 'NOT_FOUND', message: 'claim submission not found' }
  const evaluatedAt = (await readTransactionTimestamp(tx)).toISOString()
  const base = { contractVersion: RECEIPT_CONTRACT_VERSION, submissionId: freeze.id, submissionContractVersion: freeze.submissionContractVersion, payloadSha256: freeze.payloadSha256, evaluatedAt } as const
  if (freeze.submissionContractVersion !== 'A6-SUBMISSION-2') return { ok: true, value: { ...base, verificationStatus: 'LEGACY_PROVENANCE_UNVERIFIED', validationRunId: null, manifest: null } }
  const bytes = freeze.canonicalPayloadBytes
  if (createHash('sha256').update(bytes).digest('hex') !== freeze.payloadSha256) return conflict('H5: the frozen bytes do not match their SHA-256')
  const runId = freeze.claim.preClaimReadinessAssessment.validationRunId
  const verified = await verifyReceiptsAsRecorded(runId, tx)
  if (!verified.ok) return verified
  const section = readFrozenCodingSection(bytes)
  const recorded = verified.value.manifest
  if (!section || section.manifestSha256 !== recorded.manifestSha256 || JSON.stringify([...section.receiptIds].sort()) !== JSON.stringify(recorded.receipts.map((r) => r.receiptId).sort()))
    return conflict("H5: the frozen payload's coding section differs from the recorded receipts")
  return { ok: true, value: { ...base, verificationStatus: 'VERIFIED_AS_RECORDED', validationRunId: runId, manifest: recorded } }
}

export async function getSubmissionCodingProvenance(submissionId: string) {
  return withReadSnapshot(undefined, (tx) => getSubmissionCodingProvenanceOf(submissionId, tx))
}

// ---- the maintenance writer (no HTTP route; synthetic scopes only in Checkpoint B) ----------------------------

export async function recordValidationScope(input: { jurisdictionCode: string; authorityCode: string; scopeStatus: 'ENABLED' | 'DISABLED'; decisionReference: string }) {
  const jurisdictionCode = norm(input.jurisdictionCode)
  const authorityCode = norm(input.authorityCode)
  const scopeClass = authorityCode.startsWith('SYN-') ? 'SYNTHETIC' : 'REGULATORY'
  return prisma.$transaction(
    async (tx) => {
      const latest = await findLatestScopeDecision(jurisdictionCode, authorityCode, tx)
      return insertScopeDecision({ jurisdictionCode, authorityCode, scopeClass, sequence: (latest?.sequence ?? 0) + 1, scopeStatus: input.scopeStatus, decisionReference: input.decisionReference.trim() }, tx)
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
}

// The recorded receipts of a run by target id (what A6-PAYLOAD-2 binds), read after the handoff verified them as
// recorded on the same snapshot.
export async function findRecordedReceiptsByTarget(runId: string, tx: DbClient) {
  const receipts = await findReceiptsOfRun(runId, tx)
  return new Map(
    receipts.map((r) => [
      (r.encounterDiagnosisId ?? r.encounterActivityId) as string,
      { receiptId: r.id, decisionCode: r.decisionCode, codeSystem: r.codeSystem, referenceDatasetVersionId: r.referenceDatasetVersionId, membershipId: r.membershipId, sourceRowSha256: r.sourceRowSha256 },
    ]),
  )
}
