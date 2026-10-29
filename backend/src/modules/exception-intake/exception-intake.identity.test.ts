import test from 'node:test'
import assert from 'node:assert/strict'
import { identityKeyOf, identityPreimage } from './exception-intake.identity.ts'
import { establishedReasons } from './exception-intake.basis.ts'

// A8.1 — the dedupe identity and the owner-verdict basis rule. Synthetic values only.

const ORG = '00000000-0000-4000-8000-0000000000a1'
const CLAIM = '00000000-0000-4000-8000-0000000000c1'
const parts = { organizationId: ORG, claimId: CLAIM, sourceKind: 'REVENUE_TIMELINE', sourceRecordId: CLAIM, sourceContractVersion: 'A7-REVENUE-TIMELINE-1', exceptionReasonCode: 'PROVENANCE_CONFLICT' }

test('the identity is a stable SHA-256 of one canonical preimage', () => {
  assert.equal(
    identityPreimage(parts),
    `A8-EXCEPTION-INTAKE-1\norganization=${ORG}\nclaim=${CLAIM}\nsourceKind=REVENUE_TIMELINE\nsourceRecord=${CLAIM}\nsourceContract=A7-REVENUE-TIMELINE-1\nreason=PROVENANCE_CONFLICT\n`,
  )
  assert.match(identityKeyOf(parts), /^[0-9a-f]{64}$/)
  assert.equal(identityKeyOf(parts), identityKeyOf({ ...parts }))
  const keys = new Set(Array.from({ length: 100 }, () => identityKeyOf(parts)))
  assert.equal(keys.size, 1)
})

test('every identity part changes the key', () => {
  const base = identityKeyOf(parts)
  for (const change of [
    { organizationId: '00000000-0000-4000-8000-0000000000a2' },
    { claimId: '00000000-0000-4000-8000-0000000000c2' },
    { sourceKind: 'CLOSURE_PREREQUISITE_ASSESSMENT' },
    { sourceRecordId: '00000000-0000-4000-8000-0000000000d1' },
    { sourceContractVersion: 'A7-CLOSURE-PREREQ-1' },
    { exceptionReasonCode: 'OPERATOR_REVIEW_REQUIRED' },
  ]) {
    assert.notEqual(identityKeyOf({ ...parts, ...change }), base, JSON.stringify(change))
  }
})

test('non-canonical parts are refused, so two inputs can never share a preimage', () => {
  for (const change of [
    { claimId: CLAIM.toUpperCase() },
    { claimId: `${CLAIM}\nreason=X` },
    { sourceKind: 'revenue_timeline' },
    { sourceKind: 'REVENUE_TIMELINE\nreason=X' },
    { exceptionReasonCode: 'A=B' },
    { exceptionReasonCode: '' },
    { sourceContractVersion: 'A7 REVENUE' },
  ]) {
    assert.throws(() => identityPreimage({ ...parts, ...change }), /not canonical/, JSON.stringify(change))
  }
})

test('the basis is only the owner verdict mapped to each reason', () => {
  assert.deepEqual(establishedReasons({ kind: 'REVENUE_TIMELINE', timelineCode: 'REVENUE_TIMELINE_PROVENANCE_CONFLICT' }), ['PROVENANCE_CONFLICT'])
  assert.deepEqual(establishedReasons({ kind: 'REVENUE_TIMELINE', timelineCode: 'OK' }), [])
  assert.deepEqual(establishedReasons({ kind: 'REVENUE_TIMELINE', timelineCode: 'VALIDATION_ERROR' }), [])
  assert.deepEqual(establishedReasons({ kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', traceCode: 'CLOSURE_BASIS_PROVENANCE_CONFLICT', assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' }), ['HISTORICAL_RECORD_INCONSISTENT'])
  assert.deepEqual(establishedReasons({ kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', traceCode: 'OK', assessmentCode: 'REVIEW_REQUIRED' }), ['OPERATOR_REVIEW_REQUIRED'])
  assert.deepEqual(establishedReasons({ kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', traceCode: 'CLOSURE_BASIS_PROVENANCE_CONFLICT', assessmentCode: 'REVIEW_REQUIRED' }), ['HISTORICAL_RECORD_INCONSISTENT', 'OPERATOR_REVIEW_REQUIRED'])
})

test('external financial evidence absence and every normal outcome establish nothing', () => {
  for (const assessmentCode of ['EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'NO_SOURCE_BASIS', 'INCOMPLETE_SOURCE_CHAIN', 'UNSUPPORTED_SOURCE_BASIS', 'PAID', '']) {
    assert.deepEqual(establishedReasons({ kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', traceCode: 'OK', assessmentCode }), [], assessmentCode)
  }
  assert.deepEqual(establishedReasons({ kind: 'CLOSURE_PREREQUISITE_ASSESSMENT', traceCode: 'NOT_FOUND', assessmentCode: 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' }), [])
})
