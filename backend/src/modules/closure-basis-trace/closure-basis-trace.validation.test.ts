import test from 'node:test'
import assert from 'node:assert/strict'
import { isTraceUuid } from './closure-basis-trace.validation.ts'

// A7.6 — the assessment id in the path is the only input.

test('a canonical UUID is accepted', () => {
  assert.equal(isTraceUuid('9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'), true)
})

test('malformed, injected and non-string ids are refused', () => {
  for (const value of ['', 'not-a-uuid', '9f1c2a3e5b6d4e7f8a9b0c1d2e3f4a5b', '9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5', "1' OR '1'='1", '9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b/basis-trace', null, undefined, 42, {}]) {
    assert.equal(isTraceUuid(value), false, String(value))
  }
})
