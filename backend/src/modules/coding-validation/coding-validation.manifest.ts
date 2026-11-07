import { createHash } from 'node:crypto'
import type { CodingReleaseItemDto } from '../coding-release/coding-release.types.ts'
import { canonicalCode } from '../coding-release/coding-release.resolver.ts'
import { codingReleaseFindings, type ManifestReceipt, type ReceiptPlan } from './coding-validation.types.ts'

// CRG-RECEIPT-1 — pure functions only: the A5-VAL-2 coding findings and receipt plans of one Checkpoint A answer, and
// the canonical manifest of a run's receipts. No database, clock, locale or randomness.

const dash = (value: string | null) => (value === null ? '-' : value)

// One receipt's canonical line: TAB-separated, '-' for NULL, LF-terminated — byte-identical to the database guard's
// crg_receipt_manifest_line().
export function manifestLine(receipt: ManifestReceipt): string {
  return (
    [
      receipt.subjectKind,
      receipt.targetId,
      receipt.validationFindingId,
      receipt.masterCodeId,
      dash(receipt.codeSystem),
      dash(receipt.canonicalCode),
      receipt.decisionCode,
      dash(receipt.codeSystemDatasetId),
      dash(receipt.releaseImportId),
      dash(receipt.referenceDatasetVersionId),
      dash(receipt.membershipId),
      dash(receipt.sourceRowSha256),
    ].join('\t') + '\n'
  )
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// The receipts in manifest order: subject kind, then target id, compared by code unit (the database uses COLLATE "C").
export function manifestOrder<T extends Pick<ManifestReceipt, 'subjectKind' | 'targetId'>>(receipts: readonly T[]): T[] {
  return [...receipts].sort((a, b) => byCodeUnit(a.subjectKind, b.subjectKind) || byCodeUnit(a.targetId, b.targetId))
}

// The run's manifest: its receipt count and the SHA-256 of the ordered canonical lines (of no line, for zero receipts).
export function manifestOf(receipts: readonly ManifestReceipt[]): { receiptCount: number; manifestSha256: string } {
  const text = manifestOrder(receipts).map(manifestLine).join('')
  return { receiptCount: receipts.length, manifestSha256: createHash('sha256').update(text, 'utf8').digest('hex') }
}

// The A2 master value of one target, as the Checkpoint A resolver read it on the same transaction.
export type TargetMaster = { subjectKind: 'DIAGNOSIS' | 'PROCEDURE'; targetId: string; masterValue: string | null }

// One coding-release finding draft (CODING layer) and its receipt plan per Checkpoint A item. The canonical code is
// the master value in the resolver's own canonical form whenever the decision names a code system; the dataset mapping
// is the edition's CRG mapping; the scope codes are stored trimmed and upper-cased.
export function codingReleasePlans(
  check: { serviceDate: string; jurisdictionCode: string; authorityCode: string; items: readonly CodingReleaseItemDto[] },
  masters: ReadonlyMap<string, TargetMaster>,
  mappingOfDataset: ReadonlyMap<string, string>,
): { ok: true; value: { finding: { findingCode: string; outcome: 'PASS' | 'FAIL'; message: string; encounterDiagnosisId: string | null; encounterActivityId: string | null; referenceDatasetVersionId: string | null }; plan: ReceiptPlan }[] } | { ok: false; detail: string } {
  const out = []
  for (const item of check.items) {
    const master = masters.get(item.subjectId)
    if (!master || master.subjectKind !== item.subjectKind) return { ok: false, detail: 'a coding target was not read on the same snapshot' }
    const code = item.codeSystem === null ? null : canonicalCode(master.masterValue)
    if (item.codeSystem !== null && code === null) return { ok: false, detail: 'a code with a code system has no canonical value' }
    const edition = item.edition
    const mapping = edition ? (mappingOfDataset.get(edition.datasetId) ?? null) : null
    if (edition && !mapping) return { ok: false, detail: "an edition's dataset has no CRG mapping" }
    const catalog = codingReleaseFindings[item.decisionCode]
    out.push({
      finding: {
        findingCode: catalog.findingCode,
        outcome: catalog.outcome,
        message: catalog.message,
        encounterDiagnosisId: item.subjectKind === 'DIAGNOSIS' ? item.subjectId : null,
        encounterActivityId: item.subjectKind === 'PROCEDURE' ? item.subjectId : null,
        referenceDatasetVersionId: edition?.referenceDatasetVersionId ?? null,
      },
      plan: {
        subjectKind: item.subjectKind,
        targetId: item.subjectId,
        masterCodeId: item.masterCodeId,
        codeSystem: item.codeSystem,
        canonicalCode: code,
        decisionCode: item.decisionCode,
        codeSystemDatasetId: mapping,
        releaseImportId: edition?.importId ?? null,
        referenceDatasetVersionId: edition?.referenceDatasetVersionId ?? null,
        membershipId: item.membership?.membershipId ?? null,
        sourceRowSha256: item.membership?.sourceRowSha256 ?? null,
        releaseContentHash: item.membership?.releaseContentHash ?? null,
        membershipFingerprintSha256: edition?.membershipFingerprintSha256 ?? null,
        serviceDate: check.serviceDate,
        jurisdictionCode: check.jurisdictionCode.trim().toUpperCase(),
        authorityCode: check.authorityCode.trim().toUpperCase(),
      },
    })
  }
  return { ok: true, value: out }
}

// The validator selection rule (CRG-VALSCOPE-1 §4), pure: the latest decision of the encounter's scope.
export function selectValidator(latest: { scopeClass: string; scopeStatus: string } | null): { validatorVersion: 'A5-VAL-1' | 'A5-VAL-2' } | { suspended: true } {
  if (latest === null) return { validatorVersion: 'A5-VAL-1' }
  if (latest.scopeStatus === 'ENABLED') return { validatorVersion: 'A5-VAL-2' }
  if (latest.scopeClass === 'REGULATORY') return { suspended: true }
  return { validatorVersion: 'A5-VAL-1' }
}
