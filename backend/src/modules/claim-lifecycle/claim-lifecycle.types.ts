// A6.8 — the internal lifecycle of a frozen ClaimSubmission answers one question: what internal disposition
// has an authorized person recorded for ONE immutable A6.7 freeze? The disposition is derived, never stored:
// it is computed from the freeze's append-only lifecycle events by one pure reducer. An untouched freeze is
// FROZEN without any row.
//
// These are internal SBN processing dispositions, NOT external or payer states. None of them means
// submitted, sent, received, adjudicated, accepted or paid: A9 owns delivery and payer responses, A6.9
// owns correction and supersession, A7 owns financial closure. Nothing here changes the frozen bytes,
// digests, evidence package or the A6.5 approval.
//
// Physical storage: claim_freeze_lifecycle_events (named after the A6.7 claim_freezes table it belongs to;
// the column, routes, permissions, audit and contract keep the business vocabulary).

export const LIFECYCLE_CONTRACT_VERSION = 'A6-LIFECYCLE-1'

export const lifecycleStates = ['FROZEN', 'HELD', 'RELEASE_ELIGIBLE', 'WITHDRAWN_INTERNAL'] as const
export type LifecycleState = (typeof lifecycleStates)[number]

export const lifecycleEventCodes = ['PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE', 'WITHDRAW_INTERNAL'] as const
export type LifecycleEventCode = (typeof lifecycleEventCodes)[number]

// §3 — the controlled reason vocabulary. INTERNAL_OTHER is a code, never a free-text field.
export const lifecycleReasonCodes = ['INTERNAL_DATA_REVIEW', 'INTERNAL_DOCUMENTATION_PENDING', 'INTERNAL_SUPERVISOR_DIRECTION', 'INTERNAL_CORRECTION_PENDING', 'INTERNAL_OTHER'] as const
export type LifecycleReasonCode = (typeof lifecycleReasonCodes)[number]

// §2 — the complete A6-LIFECYCLE-1 transition table. Every edge not listed is refused (409): no RELEASE_HOLD
// from FROZEN, no repeated AUTHORIZE_RELEASE, nothing after WITHDRAWN_INTERNAL. The database guard holds the
// same table (claim_freeze_lifecycle_events_insert_guard).
export const lifecycleTransitions: Readonly<Record<LifecycleState, Partial<Readonly<Record<LifecycleEventCode, LifecycleState>>>>> = {
  FROZEN: { PLACE_HOLD: 'HELD', AUTHORIZE_RELEASE: 'RELEASE_ELIGIBLE', WITHDRAW_INTERNAL: 'WITHDRAWN_INTERNAL' },
  HELD: { RELEASE_HOLD: 'FROZEN', WITHDRAW_INTERNAL: 'WITHDRAWN_INTERNAL' },
  RELEASE_ELIGIBLE: { PLACE_HOLD: 'HELD', WITHDRAW_INTERNAL: 'WITHDRAWN_INTERNAL' },
  WITHDRAWN_INTERNAL: {},
}

// AUTHORIZE_RELEASE carries no reason; every other event requires one controlled reason.
export const reasonRequired = (eventCode: LifecycleEventCode) => eventCode !== 'AUTHORIZE_RELEASE'

// §6 — the validated request. Submission from the path; actor, sequence and every instant from the server.
export type LifecycleEventRequest = {
  eventCode: LifecycleEventCode
  reasonCode: LifecycleReasonCode | null
}

// §5 — identifiers, codes, the submission-local sequence and UTC instants only: no patient, payer, amount,
// digest or payload.
export type LifecycleEventDto = {
  id: string
  submissionId: string
  sequence: number
  eventCode: LifecycleEventCode
  reasonCode: LifecycleReasonCode | null
  actorUserId: string
  lifecycleContractVersion: string
  occurredAt: string
  createdAt: string
}

export type LifecycleEventListDto = { items: LifecycleEventDto[] }

// §5 — the derived disposition: the state, the event it rests on (null for an untouched FROZEN freeze) and
// the database time it was evaluated at.
export type LifecycleStateDto = {
  submissionId: string
  lifecycleContractVersion: string
  state: LifecycleState
  lastEventId: string | null
  lastSequence: number
  evaluatedAt: string
}

export type RecordedLifecycleEventDto = { event: LifecycleEventDto; lifecycle: LifecycleStateDto }

// §4–§6 — refusals. Every refused transition and every unresolved integrity problem is a safe 409.
export type ClaimLifecycleErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CLAIM_LIFECYCLE_TRANSITION_NOT_ALLOWED' | 'CLAIM_LIFECYCLE_CONFLICT'

export type ClaimLifecycleResult<T> = { ok: true; value: T } | { ok: false; code: ClaimLifecycleErrorCode; message: string }
