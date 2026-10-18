import {
  LIFECYCLE_CONTRACT_VERSION,
  lifecycleEventCodes,
  lifecycleReasonCodes,
  lifecycleTransitions,
  reasonRequired,
  type LifecycleEventCode,
  type LifecycleState,
} from './claim-lifecycle.types.ts'

// A6.8 §7 — the one pure lifecycle reducer. Input: the immutable events of ONE frozen submission in
// ascending sequence. It replays them through the A6-LIFECYCLE-1 transition table and returns the derived
// disposition, or refuses a history it cannot trust: a gap or repeat in 1..N, an unknown code, a reason
// that breaks the event shape, another contract version or an illegal edge. It never selects by
// identifier or time and never guesses. Nothing here reads a clock, the environment or the database.

export type ReducibleEvent = {
  sequence: number
  eventCode: string
  reasonCode: string | null
  lifecycleContractVersion: string
}

export type Reduction = { ok: true; state: LifecycleState; lastSequence: number } | { ok: false; reason: string }

const isEventCode = (value: string): value is LifecycleEventCode => (lifecycleEventCodes as readonly string[]).includes(value)
const isReasonCode = (value: string | null) => value !== null && (lifecycleReasonCodes as readonly string[]).includes(value)

// The state an event leads to from `state`, or null when the edge is not in the table.
export function nextLifecycleState(state: LifecycleState, eventCode: LifecycleEventCode): LifecycleState | null {
  return lifecycleTransitions[state][eventCode] ?? null
}

export function reduceLifecycle(events: readonly ReducibleEvent[]): Reduction {
  let state: LifecycleState = 'FROZEN'
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) return { ok: false, reason: `the history is not sequences 1..N (position ${index + 1} holds ${event.sequence})` }
    if (event.lifecycleContractVersion !== LIFECYCLE_CONTRACT_VERSION) return { ok: false, reason: `event ${event.sequence} is not ${LIFECYCLE_CONTRACT_VERSION}` }
    if (!isEventCode(event.eventCode)) return { ok: false, reason: `event ${event.sequence} has an unknown code` }
    if (reasonRequired(event.eventCode) ? !isReasonCode(event.reasonCode) : event.reasonCode !== null)
      return { ok: false, reason: `event ${event.sequence} does not have the ${event.eventCode} reason shape` }
    const next = nextLifecycleState(state, event.eventCode)
    if (next === null) return { ok: false, reason: `event ${event.sequence} (${event.eventCode}) is not allowed from ${state}` }
    state = next
  }
  return { ok: true, state, lastSequence: events.length }
}
