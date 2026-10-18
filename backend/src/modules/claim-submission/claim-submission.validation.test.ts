import test from 'node:test'
import assert from 'node:assert/strict'
import { validateFreezeBody } from './claim-submission.validation.ts'

// A6.7 — the strict freeze request. Synthetic identifiers only.

const A = '00000000-0000-4000-8000-000000000001'
const B = '00000000-0000-4000-8000-000000000002'

test('exactly { draftAssessmentId, approvalDecisionId } is accepted, ids lowercased', () => {
  assert.deepEqual(validateFreezeBody({ draftAssessmentId: A, approvalDecisionId: B }), { ok: true, value: { draftAssessmentId: A, approvalDecisionId: B } })
  const upper = 'ABCDEF00-0000-4000-8000-000000000001'
  assert.deepEqual(validateFreezeBody({ draftAssessmentId: upper, approvalDecisionId: B }), { ok: true, value: { draftAssessmentId: upper.toLowerCase(), approvalDecisionId: B } })
})

test('a missing body, array, missing or malformed id is refused', () => {
  for (const body of [undefined, null, 'x', [A, B], {}, { draftAssessmentId: A }, { approvalDecisionId: B }, { draftAssessmentId: 'nope', approvalDecisionId: B }, { draftAssessmentId: A, approvalDecisionId: 42 }])
    assert.equal(validateFreezeBody(body).ok, false, JSON.stringify(body))
})

test('client payload, bytes, digests, amounts, state, sequence, actor and instants are refused by name', () => {
  for (const field of ['claimId', 'payload', 'canonicalPayloadBytes', 'payloadSha256', 'manifest', 'packageSealSha256', 'approvedAssemblyFingerprint', 'totalExtendedAmount', 'amount', 'decisionCode', 'status', 'sequence', 'createdByUserId', 'frozenAt', 'submittedAt', 'latest']) {
    const outcome = validateFreezeBody({ draftAssessmentId: A, approvalDecisionId: B, [field]: 'x' })
    assert.equal(outcome.ok, false, field)
    if (!outcome.ok) assert.match(outcome.message, new RegExp(`^${field} cannot be supplied`))
  }
})

test('an unknown field is refused', () => {
  const outcome = validateFreezeBody({ draftAssessmentId: A, approvalDecisionId: B, note: 'x' })
  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.message, 'unknown field(s): note')
})
