import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleCase, caseManifestText, sha256Hex } from './evidence-case.assembler.ts'
import type { ClassificationLink, ReadinessLink, SourceLinks } from './evidence-case.types.ts'

// A7.4 — the pure case assembler and its canonical manifest. Synthetic identifiers only.

const SUB = '00000000-0000-4000-8000-0000000000f1'
const ORG = '00000000-0000-4000-8000-000000000001'
const E1 = '00000000-0000-4000-8000-0000000000e1'
const E2 = '00000000-0000-4000-8000-0000000000e2'
const C1 = '00000000-0000-4000-8000-0000000000c1'
const R1 = '00000000-0000-4000-8000-0000000000a1'
const cls = (overrides: Partial<ClassificationLink> = {}): ClassificationLink => ({ classificationId: C1, sourceEvidenceId: E1, contractVersion: 'A7-EVIDENCE-CLASS-1', normalizationOutcome: 'CLASSIFIED', ...overrides })
const rdy = (overrides: Partial<ReadinessLink> = {}): ReadinessLink => ({
  readinessId: R1, classificationId: C1, sourceEvidenceId: E1, contractVersion: 'A7-ADJ-READINESS-1', readinessCode: 'NOT_READY_FOR_ADJUDICATION', reasonCode: 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', ...overrides,
})
const linked: SourceLinks = { sourceEvidenceId: E1, classifications: [cls()], readiness: [rdy()] }
const sourceOnly: SourceLinks = { sourceEvidenceId: E2, classifications: [], readiness: [] }
const assemble = (sources: SourceLinks[]) => assembleCase({ claimSubmissionId: SUB, organizationId: ORG, sources })

test('the golden vector: exact canonical bytes and the digest PostgreSQL recomputes', () => {
  const result = assemble([linked, sourceOnly])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(
    result.value.manifestText,
    'SBN-A7-REVENUE-CASE-1\ncontract=A7-REVENUE-CASE-1\nclaimSubmissionId=00000000-0000-4000-8000-0000000000f1\norganizationId=00000000-0000-4000-8000-000000000001\nassemblyCode=INVENTORY_INCOMPLETE\nsourceCount=2\nclassifiedCount=1\nreadinessCount=1\nitemCount=2\n' +
      'item=1|00000000-0000-4000-8000-0000000000e1|00000000-0000-4000-8000-0000000000c1|00000000-0000-4000-8000-0000000000a1|LINKED\nitem=2|00000000-0000-4000-8000-0000000000e2|NULL|NULL|SOURCE_ONLY\n',
  )
  assert.equal(result.value.manifestSha256, '46f333efac94b7369737f759ab70117899ba763d23629df1e851265f8317a79e')
})

test('an empty submission is NO_REVENUE_SOURCES with a stable digest and no sentinel item', () => {
  const result = assemble([])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([result.value.assemblyCode, result.value.itemCount, result.value.items.length], ['NO_REVENUE_SOURCES', 0, 0])
  assert.equal(result.value.manifestSha256, '4856f1978d81e11b81c77f87ed9c3c917b50ca7fc190a7f98ded36da88307bda')
})

test('every source linked is INVENTORY_COMPLETE, which is still not a payer verdict', () => {
  const result = assemble([linked])
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual([result.value.assemblyCode, result.value.sourceCount, result.value.classifiedCount, result.value.readinessCount], ['INVENTORY_COMPLETE', 1, 1, 1])
  assert.doesNotMatch(result.value.manifestText, /READY_FOR|ADJUDICATED|PAID|DENIED|SETTLED|BALANCE/)
})

test('a missing classification or readiness is INVENTORY_INCOMPLETE with the exact item reason', () => {
  const classifiedOnly: SourceLinks = { sourceEvidenceId: E1, classifications: [cls()], readiness: [] }
  for (const [sources, reasons] of [[[classifiedOnly], ['CLASSIFIED_NO_READINESS']], [[sourceOnly], ['SOURCE_ONLY']], [[linked, sourceOnly], ['LINKED', 'SOURCE_ONLY']]] as const) {
    const result = assemble([...sources])
    assert.equal(result.ok, true)
    if (!result.ok) continue
    assert.equal(result.value.assemblyCode, 'INVENTORY_INCOMPLETE')
    assert.deepEqual(result.value.items.map((i) => i.itemReasonCode), reasons)
  }
})

test('review and unsupported readiness results are linked, never treated as missing or as success', () => {
  for (const [normalizationOutcome, readinessCode, reasonCode] of [['NEEDS_REVIEW', 'SOURCE_REQUIRES_REVIEW', 'CLASSIFICATION_REVIEW_REQUIRED'], ['UNSUPPORTED', 'SOURCE_UNSUPPORTED', 'CLASSIFICATION_UNSUPPORTED']]) {
    const result = assemble([{ sourceEvidenceId: E1, classifications: [cls({ normalizationOutcome })], readiness: [rdy({ readinessCode, reasonCode })] }])
    assert.equal(result.ok && result.value.items[0].itemReasonCode, 'LINKED', normalizationOutcome)
  }
})

test('every broken or contradictory link is a provenance conflict, never a guessed case', () => {
  const cases: SourceLinks[][] = [
    [linked, linked],
    [{ ...linked, classifications: [cls({ sourceEvidenceId: E2 })] }],
    [{ ...linked, classifications: [cls({ contractVersion: 'A7-EVIDENCE-CLASS-2' })] }],
    [{ ...linked, classifications: [cls(), cls({ classificationId: '00000000-0000-4000-8000-0000000000c2' })] }],
    [{ ...linked, readiness: [rdy({ classificationId: '00000000-0000-4000-8000-0000000000c2' })] }],
    [{ ...linked, readiness: [rdy({ sourceEvidenceId: E2 })] }],
    [{ ...linked, readiness: [rdy({ contractVersion: 'A7-ADJ-READINESS-2' })] }],
    [{ ...linked, readiness: [rdy(), rdy({ readinessId: '00000000-0000-4000-8000-0000000000a2' })] }],
    [{ sourceEvidenceId: E1, classifications: [], readiness: [rdy()] }],
    [{ ...linked, readiness: [rdy({ readinessCode: 'READY_FOR_ADJUDICATION' })] }],
    [{ ...linked, readiness: [rdy({ readinessCode: 'SOURCE_UNSUPPORTED', reasonCode: 'CLASSIFICATION_UNSUPPORTED' })] }],
    [{ ...linked, classifications: [cls({ normalizationOutcome: 'PAID' })] }],
    [{ ...linked, sourceEvidenceId: 'E1' }],
    [{ ...linked, sourceEvidenceId: E1.toUpperCase() }],
  ]
  for (const sources of cases) assert.equal(assemble(sources).ok, false, JSON.stringify(sources).slice(0, 160))
  assert.equal(assembleCase({ claimSubmissionId: 'S1', organizationId: ORG, sources: [] }).ok, false)
})

test('ordinals follow the owner order exactly; a different order gives a different digest', () => {
  const a = assemble([linked, sourceOnly])
  const b = assemble([sourceOnly, { ...linked }])
  assert.equal(a.ok && b.ok, true)
  if (!a.ok || !b.ok) return
  assert.deepEqual(a.value.items.map((i) => i.ordinal), [1, 2])
  assert.notEqual(a.value.manifestSha256, b.value.manifestSha256)
})

test('the manifest is deterministic, ignores the time zone and locale, and refuses non-canonical fields', () => {
  const runs = Array.from({ length: 20 }, () => JSON.stringify(assemble([linked, sourceOnly])))
  assert.equal(new Set(runs).size, 1)
  assert.equal(sha256Hex('x'), '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881')
  assert.throws(() => caseManifestText({ claimSubmissionId: `${SUB}\nitem=1`, organizationId: ORG, assemblyCode: 'NO_REVENUE_SOURCES', sourceCount: 0, classifiedCount: 0, readinessCount: 0, itemCount: 0, items: [] }))
})
