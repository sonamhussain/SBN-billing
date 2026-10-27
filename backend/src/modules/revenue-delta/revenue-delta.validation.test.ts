import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeltaUuid, refusedDeltaRequest } from './revenue-delta.validation.ts'

// A7.8 — the Claim id in the path is the only input; selectors and bodies are refused.

test('a canonical Claim UUID is accepted; malformed, SQL-shaped and traversal-shaped ids are refused', () => {
  assert.equal(isDeltaUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', "1' OR '1'='1", '../../claims', '..%2F..%2Fclaims', null, undefined, 42]) {
    assert.equal(isDeltaUuid(value), false, String(value))
  }
})

test('no query and no body (or an empty parsed object) is accepted', () => {
  assert.equal(refusedDeltaRequest({}, undefined), null)
  assert.equal(refusedDeltaRequest({}, {}), null)
})

test('latest, current, payer, amount, override, source list and actor selectors are refused, never ignored', () => {
  for (const key of ['latest', 'current', 'payer', 'amount', 'override', 'sourceEvidenceIds', 'actorUserId', 'organizationId']) {
    assert.match(refusedDeltaRequest({ [key]: 'x' }, undefined) ?? '', /unsupported query parameter/, key)
  }
})

test('any body is refused', () => {
  for (const body of [{ comparisons: [] }, { claimId: 'x' }, [], 'delta', 1]) {
    assert.match(refusedDeltaRequest({}, body) ?? '', /carries no body/, JSON.stringify(body))
  }
})
