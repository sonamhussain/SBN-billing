import test from 'node:test'
import assert from 'node:assert/strict'
import { isIntakeUuid, refusedListRequest, validateIntakeRequest } from './exception-intake.validation.ts'

// A8.1 — the request is exactly four fields; everything else is refused. Synthetic values only.

const SOURCE = '9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'
const valid = { sourceKind: 'REVENUE_TIMELINE', sourceRecordId: SOURCE, sourceContractVersion: 'A7-REVENUE-TIMELINE-1', exceptionReasonCode: 'PROVENANCE_CONFLICT' }

test('canonical UUIDs only', () => {
  assert.equal(isIntakeUuid(SOURCE), true)
  for (const value of ['', 'not-a-uuid', SOURCE.replace(/-/g, ''), "1' OR '1'='1", '../../claims', null, 42]) assert.equal(isIntakeUuid(value), false, String(value))
})

test('exactly the four fields are accepted, the source id normalized to lowercase', () => {
  const result = validateIntakeRequest({ ...valid, sourceRecordId: SOURCE.toUpperCase() })
  assert.deepEqual(result, { ok: true, value: { ...valid, sourceRecordId: SOURCE } })
  assert.equal(validateIntakeRequest({ ...valid, sourceKind: 'CLOSURE_PREREQUISITE_ASSESSMENT', sourceContractVersion: 'A7-CLOSURE-PREREQ-1', exceptionReasonCode: 'OPERATOR_REVIEW_REQUIRED' }).ok, true)
})

test('client-owned, free-text and unknown fields are refused, never ignored', () => {
  for (const key of ['id', 'identityKey', 'organizationId', 'claimId', 'recordedByUserId', 'recordedAt', 'status', 'contextCode', 'amount', 'payload', 'description', 'narrative', 'resolution']) {
    const result = validateIntakeRequest({ ...valid, [key]: 'x' })
    assert.equal(result.ok, false, key)
    assert.match(result.ok ? '' : result.message, /unsupported field/, key)
  }
  for (const body of [null, [], 'x', 1, {}]) assert.equal(validateIntakeRequest(body).ok, false, JSON.stringify(body))
})

test('unknown kinds, malformed ids, fenced contracts and unknown reasons are refused', () => {
  const refused = (change: Record<string, unknown>) => validateIntakeRequest({ ...valid, ...change })
  assert.match((refused({ sourceKind: 'PAYER_RESPONSE' }) as { message: string }).message, /unknown source kind/)
  assert.match((refused({ sourceRecordId: 'not-a-uuid' }) as { message: string }).message, /invalid source record id/)
  assert.match((refused({ sourceContractVersion: 'A7-REVENUE-TIMELINE-2' }) as { message: string }).message, /unsupported source contract/)
  assert.match((refused({ sourceContractVersion: 'A7-CLOSURE-PREREQ-1' }) as { message: string }).message, /unsupported source contract/)
  assert.match((refused({ exceptionReasonCode: 'PAYER_DENIED' }) as { message: string }).message, /unknown exception reason/)
  assert.match((refused({ exceptionReasonCode: 1 }) as { message: string }).message, /unknown exception reason/)
})

test('the list read takes no query and no body', () => {
  assert.equal(refusedListRequest({}, undefined), null)
  assert.equal(refusedListRequest({}, {}), null)
  assert.match(refusedListRequest({ status: 'open' }, undefined) ?? '', /unsupported query/)
  assert.match(refusedListRequest({}, { x: 1 }) ?? '', /no body/)
})
