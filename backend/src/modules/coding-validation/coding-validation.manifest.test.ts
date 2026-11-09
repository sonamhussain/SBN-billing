import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { codingReleasePlans, manifestLine, manifestOf, manifestOrder, selectValidator, type TargetMaster } from './coding-validation.manifest.ts'
import type { CodingReleaseItemDto } from '../coding-release/coding-release.types.ts'

// CRG-01 Checkpoint B — the pure CRG-RECEIPT-1 functions: manifest lines and digest, the coding-release finding and
// receipt plans of one Checkpoint A answer, and the validator selection. Synthetic identifiers only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const hex = (c: string) => c.repeat(64)

const receipt = (n: number, o: Partial<Parameters<typeof manifestLine>[0]> = {}) => ({
  subjectKind: 'DIAGNOSIS',
  targetId: id(n),
  validationFindingId: id(100 + n),
  masterCodeId: id(200 + n),
  codeSystem: 'ICD-10-CM' as string | null,
  canonicalCode: 'A00.0' as string | null,
  decisionCode: 'APPLICABLE',
  codeSystemDatasetId: id(300) as string | null,
  releaseImportId: id(400) as string | null,
  referenceDatasetVersionId: id(500) as string | null,
  membershipId: id(600 + n) as string | null,
  sourceRowSha256: hex('a') as string | null,
  ...o,
})

test('a manifest line is TAB-separated, dash for NULL, LF-terminated (CRG-RECEIPT-1)', () => {
  assert.equal(
    manifestLine(receipt(1)),
    `DIAGNOSIS\t${id(1)}\t${id(101)}\t${id(201)}\tICD-10-CM\tA00.0\tAPPLICABLE\t${id(300)}\t${id(400)}\t${id(500)}\t${id(601)}\t${hex('a')}\n`,
  )
  const ambiguous = receipt(2, { codeSystem: null, canonicalCode: null, decisionCode: 'AMBIGUOUS_CODE_SYSTEM', codeSystemDatasetId: null, releaseImportId: null, referenceDatasetVersionId: null, membershipId: null, sourceRowSha256: null })
  assert.equal(manifestLine(ambiguous), `DIAGNOSIS\t${id(2)}\t${id(102)}\t${id(202)}\t-\t-\tAMBIGUOUS_CODE_SYSTEM\t-\t-\t-\t-\t-\n`)
})

test('the manifest digest is order-independent, deterministic and exact (CRG-070, CRG-083)', () => {
  const items = [receipt(3), receipt(1, { subjectKind: 'PROCEDURE', codeSystem: 'CPT', canonicalCode: '99213' }), receipt(2)]
  const first = manifestOf(items)
  for (let i = 0; i < 100; i += 1) assert.deepEqual(manifestOf([...items].reverse()), first)
  const ordered = manifestOrder(items)
  assert.deepEqual(ordered.map((r) => `${r.subjectKind}/${r.targetId}`), [`DIAGNOSIS/${id(2)}`, `DIAGNOSIS/${id(3)}`, `PROCEDURE/${id(1)}`])
  assert.equal(first.manifestSha256, createHash('sha256').update(ordered.map(manifestLine).join(''), 'utf8').digest('hex'))
  assert.equal(first.receiptCount, 3)
  assert.equal(manifestOf([]).manifestSha256, createHash('sha256').update('', 'utf8').digest('hex'))
  assert.notEqual(manifestOf([receipt(1), receipt(2)]).manifestSha256, manifestOf([receipt(1), receipt(2, { membershipId: id(999) })]).manifestSha256)
})

const edition = { referenceDatasetVersionId: id(500), datasetId: id(700), codeSystem: 'ICD-10-CM' as const, purpose: 'CLAIM_CODING' as const, edition: '2026', effectiveFrom: '2026-01-01', effectiveTo: null, sourceVersionId: null, contentHash: hex('c'), membershipFingerprintSha256: hex('f'), importId: id(400), activationStatus: 'ACTIVE', retirementClassification: null }
const item = (o: Partial<CodingReleaseItemDto>): CodingReleaseItemDto => ({ subjectKind: 'DIAGNOSIS', subjectId: id(1), masterCodeId: id(201), decisionCode: 'APPLICABLE', codeSystem: 'ICD-10-CM', edition, membership: { membershipId: id(601), sourceRowId: 'R1', sourceRowSha256: hex('a'), releaseContentHash: hex('c') }, ...o })
const masters = new Map<string, TargetMaster>([
  [id(1), { subjectKind: 'DIAGNOSIS', targetId: id(1), masterValue: ' a00.0 ' }],
  [id(2), { subjectKind: 'PROCEDURE', targetId: id(2), masterValue: '99213' }],
])
const mappings = new Map([[id(700), id(300)]])
const check = (items: CodingReleaseItemDto[]) => ({ serviceDate: '2026-06-15', jurisdictionCode: ' ae-du ', authorityCode: 'syn-crg-1', items })

test('each Checkpoint A decision maps to its frozen CODING finding and an exact receipt plan (CRG-051, 052, 056, 061, 062)', () => {
  const planned = codingReleasePlans(
    check([
      item({}),
      item({ subjectKind: 'PROCEDURE', subjectId: id(2), masterCodeId: id(202), decisionCode: 'CODE_NOT_IN_RELEASE', codeSystem: 'CPT', edition: { ...edition, codeSystem: 'CPT' }, membership: null }),
    ]),
    masters,
    mappings,
  )
  assert.ok(planned.ok)
  const [dx, px] = planned.value
  assert.deepEqual(dx.finding, { findingCode: 'CODING_RELEASE_APPLICABLE', outcome: 'PASS', message: dx.finding.message, encounterDiagnosisId: id(1), encounterActivityId: null, referenceDatasetVersionId: id(500) })
  assert.equal(dx.plan.canonicalCode, 'A00.0')
  assert.equal(dx.plan.jurisdictionCode, 'AE-DU')
  assert.equal(dx.plan.authorityCode, 'SYN-CRG-1')
  assert.equal(dx.plan.codeSystemDatasetId, id(300))
  assert.equal(dx.plan.membershipFingerprintSha256, hex('f'))
  assert.equal(px.finding.findingCode, 'CODING_RELEASE_CODE_NOT_IN_RELEASE')
  assert.equal(px.finding.outcome, 'FAIL')
  assert.equal(px.finding.encounterActivityId, id(2))
  assert.equal(px.plan.membershipId, null)
  assert.equal(px.plan.referenceDatasetVersionId, id(500))
  for (const decision of ['NO_APPROVED_RELEASE', 'CONFLICTING_RELEASES', 'RELEASE_NOT_AUTHORIZED', 'AMBIGUOUS_CODE_SYSTEM'] as const) {
    const refused = codingReleasePlans(check([item({ decisionCode: decision, codeSystem: decision === 'AMBIGUOUS_CODE_SYSTEM' ? null : 'ICD-10-CM', edition: null, membership: null })]), masters, mappings)
    assert.ok(refused.ok)
    assert.equal(refused.value[0].finding.outcome, 'FAIL')
    assert.equal(refused.value[0].finding.referenceDatasetVersionId, null)
    assert.equal(refused.value[0].plan.releaseImportId, null)
    assert.equal(refused.value[0].plan.canonicalCode, decision === 'AMBIGUOUS_CODE_SYSTEM' ? null : 'A00.0')
  }
})

test('a plan that cannot be exact is refused, never guessed (CRG-062, CRG-065)', () => {
  assert.equal(codingReleasePlans(check([item({ subjectId: id(9) })]), masters, mappings).ok, false)
  assert.equal(codingReleasePlans(check([item({ subjectKind: 'PROCEDURE' })]), masters, mappings).ok, false)
  assert.equal(codingReleasePlans(check([item({})]), masters, new Map()).ok, false)
  const blank = new Map<string, TargetMaster>([[id(1), { subjectKind: 'DIAGNOSIS', targetId: id(1), masterValue: '  ' }]])
  assert.equal(codingReleasePlans(check([item({})]), blank, mappings).ok, false)
})

test('the validator selection is the server rule, never a request (CRG-079, CRG-119, B-G01)', () => {
  assert.deepEqual(selectValidator(null), { validatorVersion: 'A5-VAL-1' })
  assert.deepEqual(selectValidator({ scopeClass: 'SYNTHETIC', scopeStatus: 'ENABLED' }), { validatorVersion: 'A5-VAL-2' })
  assert.deepEqual(selectValidator({ scopeClass: 'SYNTHETIC', scopeStatus: 'DISABLED' }), { validatorVersion: 'A5-VAL-1' })
  assert.deepEqual(selectValidator({ scopeClass: 'REGULATORY', scopeStatus: 'ENABLED' }), { validatorVersion: 'A5-VAL-2' })
  assert.deepEqual(selectValidator({ scopeClass: 'REGULATORY', scopeStatus: 'SUSPENDED' }), { suspended: true })
})
