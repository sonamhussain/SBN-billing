import test from 'node:test'
import assert from 'node:assert/strict'
import { isTimelineUuid, refusedRequestShape } from './revenue-timeline.validation.ts'

// A7.7 — the Claim id in the path is the only input; selectors and bodies are refused.

test('a canonical Claim UUID is accepted; malformed, injected and non-string ids are refused', () => {
  assert.equal(isTimelineUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', "1' OR '1'='1", '9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b;DROP', null, undefined, 42]) {
    assert.equal(isTimelineUuid(value), false, String(value))
  }
})

test('no query and no body (or an empty parsed object) is accepted', () => {
  assert.equal(refusedRequestShape({}, undefined), null)
  assert.equal(refusedRequestShape({}, {}), null)
  assert.equal(refusedRequestShape(undefined, undefined), null)
})

test('every selector or filter in the query string is refused, never ignored', () => {
  for (const key of ['latestOnly', 'status', 'payer', 'country', 'asOf', 'externalId', 'includePayload', 'submissionId']) {
    assert.match(refusedRequestShape({ [key]: 'true' }, undefined) ?? '', /unsupported query parameter/, key)
  }
})

test('a client-supplied history or any other body is refused', () => {
  for (const body of [{ submissions: [] }, { claimId: 'x' }, [], 'history', 1]) {
    assert.match(refusedRequestShape({}, body) ?? '', /carries no body/, JSON.stringify(body))
  }
})
