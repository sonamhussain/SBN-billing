import test from 'node:test'
import assert from 'node:assert/strict'
import { nextLifecycleState, reduceLifecycle, type ReducibleEvent } from './claim-lifecycle.reducer.ts'
import { lifecycleEventCodes, lifecycleStates, type LifecycleEventCode, type LifecycleState } from './claim-lifecycle.types.ts'
import { validateLifecycleEventBody } from './claim-lifecycle.validation.ts'

// A6.8 — the A6-LIFECYCLE-1 reducer, transition table and strict request. Synthetic values only.

const REASON = 'INTERNAL_DATA_REVIEW'
const event = (sequence: number, eventCode: string, reasonCode: string | null = eventCode === 'AUTHORIZE_RELEASE' ? null : REASON, lifecycleContractVersion = 'A6-LIFECYCLE-1'): ReducibleEvent => ({
  sequence,
  eventCode,
  reasonCode,
  lifecycleContractVersion,
})
const history = (...codes: string[]) => codes.map((code, index) => event(index + 1, code))

// The locked A6-LIFECYCLE-1 table, written out independently of the implementation.
const allowed: Record<string, LifecycleState> = {
  'FROZEN PLACE_HOLD': 'HELD',
  'FROZEN AUTHORIZE_RELEASE': 'RELEASE_ELIGIBLE',
  'FROZEN WITHDRAW_INTERNAL': 'WITHDRAWN_INTERNAL',
  'HELD RELEASE_HOLD': 'FROZEN',
  'HELD WITHDRAW_INTERNAL': 'WITHDRAWN_INTERNAL',
  'RELEASE_ELIGIBLE PLACE_HOLD': 'HELD',
  'RELEASE_ELIGIBLE WITHDRAW_INTERNAL': 'WITHDRAWN_INTERNAL',
}

test('every one of the 16 state/event pairs follows the locked table exactly', () => {
  for (const state of lifecycleStates)
    for (const code of lifecycleEventCodes) assert.equal(nextLifecycleState(state, code), allowed[`${state} ${code}`] ?? null, `${state} ${code}`)
  assert.equal(Object.keys(allowed).length, 7)
})

test('an untouched freeze is FROZEN with no event', () => {
  assert.deepEqual(reduceLifecycle([]), { ok: true, state: 'FROZEN', lastSequence: 0 })
})

test('the worked scenario: hold, release hold, authorize release', () => {
  assert.deepEqual(reduceLifecycle(history('PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE')), { ok: true, state: 'RELEASE_ELIGIBLE', lastSequence: 3 })
})

test('hold cancels release eligibility; withdrawal is reachable from every non-terminal state', () => {
  assert.deepEqual(reduceLifecycle(history('AUTHORIZE_RELEASE', 'PLACE_HOLD')), { ok: true, state: 'HELD', lastSequence: 2 })
  for (const prefix of [[], ['PLACE_HOLD'], ['AUTHORIZE_RELEASE']]) {
    const reduced = reduceLifecycle(history(...prefix, 'WITHDRAW_INTERNAL'))
    assert.ok(reduced.ok && reduced.state === 'WITHDRAWN_INTERNAL', prefix.join(','))
  }
})

test('forbidden edges, duplicates and anything after the terminal state are refused', () => {
  for (const codes of [
    ['RELEASE_HOLD'],
    ['PLACE_HOLD', 'PLACE_HOLD'],
    ['PLACE_HOLD', 'AUTHORIZE_RELEASE'],
    ['AUTHORIZE_RELEASE', 'AUTHORIZE_RELEASE'],
    ['AUTHORIZE_RELEASE', 'RELEASE_HOLD'],
    ...lifecycleEventCodes.map((code) => ['WITHDRAW_INTERNAL', code]),
  ])
    assert.equal(reduceLifecycle(history(...codes)).ok, false, codes.join(','))
})

test('a gap, a repeat, a reordering or a start other than 1 is refused, never guessed', () => {
  for (const events of [
    [event(2, 'PLACE_HOLD')],
    [event(1, 'PLACE_HOLD'), event(3, 'RELEASE_HOLD')],
    [event(1, 'PLACE_HOLD'), event(1, 'RELEASE_HOLD')],
    [event(2, 'RELEASE_HOLD'), event(1, 'PLACE_HOLD')],
    [event(0, 'PLACE_HOLD')],
  ])
    assert.equal(reduceLifecycle(events).ok, false, JSON.stringify(events))
})

test('an unknown code, another contract version or a broken reason shape is refused', () => {
  for (const events of [
    [event(1, 'SEND')],
    [event(1, 'PLACE_HOLD', REASON, 'A6-LIFECYCLE-2')],
    [event(1, 'PLACE_HOLD', null)],
    [event(1, 'PLACE_HOLD', 'free text')],
    [event(1, 'AUTHORIZE_RELEASE', REASON)],
  ])
    assert.equal(reduceLifecycle(events).ok, false, JSON.stringify(events))
})

test('the reducer is deterministic and does not mutate its input', () => {
  const events = history('PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE', 'PLACE_HOLD')
  const copy = JSON.parse(JSON.stringify(events))
  assert.deepEqual(reduceLifecycle(events), reduceLifecycle(copy))
  assert.deepEqual(events, copy)
})

test('the request is exactly { eventCode, reasonCode }', () => {
  assert.deepEqual(validateLifecycleEventBody({ eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' }), { ok: true, value: { eventCode: 'PLACE_HOLD', reasonCode: 'INTERNAL_OTHER' } })
  assert.deepEqual(validateLifecycleEventBody({ eventCode: 'AUTHORIZE_RELEASE', reasonCode: null }), { ok: true, value: { eventCode: 'AUTHORIZE_RELEASE', reasonCode: null } })
  const refused: unknown[] = [
    undefined,
    null,
    [],
    {},
    { eventCode: 'PLACE_HOLD' },
    { reasonCode: REASON },
    { eventCode: 'PLACE_HOLD', reasonCode: null },
    { eventCode: 'PLACE_HOLD', reasonCode: 'free text' },
    { eventCode: 'AUTHORIZE_RELEASE', reasonCode: REASON },
    { eventCode: 'AUTHORIZE_RELEASE' },
    { eventCode: 'SEND', reasonCode: REASON },
    { eventCode: 'place_hold', reasonCode: REASON },
    { eventCode: 'PLACE_HOLD', reasonCode: REASON, note: 'x' },
  ]
  for (const body of refused) assert.equal(validateLifecycleEventBody(body).ok, false, JSON.stringify(body))
})

test('server-owned and transport fields are refused by name', () => {
  for (const field of ['actorUserId', 'sequence', 'status', 'state', 'occurredAt', 'createdAt', 'destination', 'payer', 'externalReference', 'payloadDigest', 'idempotencyKey']) {
    const outcome = validateLifecycleEventBody({ eventCode: 'PLACE_HOLD', reasonCode: REASON, [field]: 'x' })
    assert.equal(outcome.ok, false, field)
    if (!outcome.ok) assert.match(outcome.message, new RegExp(`^${field} cannot be supplied`))
  }
})

test('every event code reaches a typed result', () => {
  for (const code of lifecycleEventCodes as readonly LifecycleEventCode[]) {
    const body = { eventCode: code, reasonCode: code === 'AUTHORIZE_RELEASE' ? null : REASON }
    assert.equal(validateLifecycleEventBody(body).ok, true, code)
  }
})
