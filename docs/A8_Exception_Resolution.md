# A8.7 Internal Exception Resolution Decision — Contract Register (A8-RESOLUTION-DECISION-1)

A8.7 (contract `A8-RESOLUTION-DECISION-1`) records whether one A8.1 exception may be treated as **internally resolved**
on the strength of its one independently verified A8.6 work record. The current A8.2 assignee requests the internal
resolution; a different, authorized member confirms it or returns it. Each request and each decision is one append-only
event in a server-numbered sequence. The resolution disposition is never stored: it is derived from the exact sequence
on every read.

`RESOLVED_INTERNAL` is an **internal decision only**. A8.7 never does any of the following:

- execute the approved A8.5 action, or correct, close or escalate anything;
- assert a payer acknowledgement, revenue closure, or a cured patient, clinical, payment or financial issue;
- change the intake, its triage, investigation, remediation or remediation work history, the Claim, any A2–A7 or CRG
  record, or any source record.

## Start gate

- **Predecessors.** A8.5 was merged as PR #104 at `0f8f9d3bc18347b1360b72b93056724b594a6e00`. A8.6 was merged as PR #106
  at `18de6c81f9f47374d011cfe9a688b500b8c17beb` and accepted and closed at that merge by the architecture owner.
- **Branch.** `feature/a8-7-internal-exception-resolution` is cut from clean, synchronized main
  `18de6c81f9f47374d011cfe9a688b500b8c17beb` (the A8.6 merge), which contains both merges. It is not stacked on a feature
  branch.
- **A8.4 stays closed.** On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of
  A8.3. No A8.4 code exists.
- **CRG-01 is independent.** A8.7 writes no CRG record, enables no real DHA/DOH scope, imports nothing and selects no
  coding release. No Checkpoint C work is part of A8.7.
- **Design approval.** On 2026-11-10 the architecture owner approved the A8.7 architecture (contract, the four-state
  matrix and the evidence linkage) with two specification corrections, both applied here:
  1. `RETURNED_FOR_REWORK` is terminal in v1: any new resolution request after a return is refused with 409. Rework
     needs a separately approved future version; A8.5 and A8.6 are not changed for it.
  2. Every A8.7 route requires all five upstream read permissions (A8.1, A8.2, A8.3, A8.5 and A8.6), together with the
     route's own `exceptionResolution.request`, `.decide` or `.read` permission.
- **Accepted interfaces used here, unchanged:**
  - A8.1 `getExceptionIntakesOf(claimId, tx)`;
  - A8.2 `getTriageDispositionOf(claimId, exceptionIntakeId, tx)`, with `dispositionCode`, `assignedMemberId` and
    `assigneeCurrentlyEligible`;
  - A8.3 `getInvestigationHistoryOf(claimId, exceptionIntakeId, tx)`;
  - A8.5 `getRemediationDispositionOf(claimId, exceptionIntakeId, tx)` (its `state` and `approvedProposalEventId`);
  - A8.6 `getWorkDispositionOf(claimId, exceptionIntakeId, tx)` (its `state`, `approvedProposalEventId` and
    `verification.workEventId`) and `getWorkHistoryOf(claimId, exceptionIntakeId, tx)`;
  - the A6.7 Claim ownership path;
  - the Claim row lock taken first by every A8 write.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/resolution-events` | `exceptionIntake.read` + `exceptionTriage.read` + `exceptionInvestigation.read` + `exceptionRemediation.read` + `exceptionRemediationWork.read`, plus the event's own permission: `exceptionResolution.request` for a request or `exceptionResolution.decide` for a decision (Admin) | 201 with the recorded event |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/resolution-history` | the five read permissions + `exceptionResolution.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/resolution-disposition` | the five read permissions + `exceptionResolution.read` (Admin, Viewer) | 200, the derived disposition |

**Error answers:**

| Situation | Answer |
|---|---|
| No session | 401, before any lookup |
| A missing permission | 403 |
| A Claim, intake or A8.6 work event of another organization, Claim or intake | 404, the same as a missing one |
| A malformed id or body, or an unknown field or code | 400 `VALIDATION_ERROR` |
| A requester who is not the current, eligible assignee holding the request permission | 409 `EXCEPTION_RESOLUTION_NOT_ASSIGNEE` |
| A decider without the decide permission now, or the request's own requester | 409 `EXCEPTION_RESOLUTION_REVIEWER_NOT_INDEPENDENT` |
| A request or decision without the exact verified basis (no A8.6 `VERIFIED_INTERNAL_WORK`, an `EVIDENCE_NOT_VERIFIED` verification, another work event of this intake, or a basis that no longer holds) | 409 `EXCEPTION_RESOLUTION_BASIS_NOT_VERIFIED` |
| An event that is not a legal next step | 409 `EXCEPTION_RESOLUTION_TRANSITION_REFUSED` |
| A conflicting or uncertain write, or an inconsistent stored or owner history | 409 `EXCEPTION_RESOLUTION_CONFLICT` |

- The GETs accept no query or body.
- There is no PUT, PATCH or DELETE, no collection, queue, current or sequence selector, and no execution, claim
  correction, closure, escalation, SLA, export, payer or transmission route.
- Audit `exception_resolution.recorded` (entity `EXCEPTION_RESOLUTION_EVENT`) is written exactly once per recorded
  event, in the same transaction, metadata only.
- The reader for a future owner is `getResolutionDispositionOf(claimId, exceptionIntakeId, tx)`. It reads on the
  caller's transaction and opens none of its own.

## Who may write

**Requester (D4).** The member to whom the exception is presently assigned in A8.2, and only while:

- the A8.2 disposition is `ASSIGNED` to exactly the acting user's membership of the organization;
- that assignment is still eligible under the accepted A8.2 policy (`assigneeCurrentlyEligible`);
- the membership holds `exceptionResolution.request` now;
- the intake's A8.6 disposition is `VERIFIED_INTERNAL_WORK`, on exactly the plan its A8.5 disposition reports as
  `APPROVED_FOR_PLANNING`.

**Decider (D5).** A member of the same organization, and only while:

- the membership holds `exceptionResolution.decide` now (checked at decision time);
- the membership and the user both differ from the request's, so a user acting through another membership is refused;
- the exception is still `ASSIGNED`;
- the decision names exactly the request that awaits a decision;
- the request's recorded basis is still the intake's verified A8.6 record (D6).

The A8.5 approver and the A8.6 verifier may decide. Independence is judged against the requester only. There is no
Admin override and no automatic event from CRG, A7 or A8.6.

## Events (v1)

The request is exactly one event code and its own controlled fields; anything else is a 400. The server derives the
actor and membership, the organization, the Claim, the sequence and the time.

| eventCode | Request fields | Rule |
|---|---|---|
| `REQUEST_INTERNAL_RESOLUTION` | `verificationEventId`, `reasonCode` | The verification is exactly the intake's A8.6 `verification.workEventId`, with A8.6 in `VERIFIED_INTERNAL_WORK` (`EVIDENCE_SUPPORTED`) on the same approved A8.5 plan, Claim, intake and organization. No request awaits a decision and none was decided. |
| `DECIDE_INTERNAL_RESOLUTION` | `requestEventId`, `decisionCode`, and `returnReasonCode` exactly when the code is `RETURN_FOR_REWORK` | The request is exactly the one that awaits a decision; the decider is independent and authorized now; the basis still holds. |

**Controlled values:**
- `reasonCode` (request): `VERIFIED_INTERNAL_WORK`.
- `decisionCode`: `CONFIRM_INTERNAL_RESOLUTION`, `RETURN_FOR_REWORK`.
- `returnReasonCode` (`RETURN_FOR_REWORK` only): `INSUFFICIENT_SUPPORT`, `SOURCE_INTEGRITY_CONCERN`,
  `ADDITIONAL_WORK_REQUIRED`. A confirmation carries no return reason.

## Derived disposition (D8)

| State | Meaning |
|---|---|
| `NO_RESOLUTION_REQUEST` | No event (zero rows; nothing stored). Never inferred from the A8.6 verification alone. |
| `AWAITING_RESOLUTION_DECISION` | The latest event is the request; `request` names it |
| `RESOLVED_INTERNAL` | The request was confirmed. Terminal in v1; reopening and broader closure are future versioned decisions. |
| `RETURNED_FOR_REWORK` | The request was returned with its reason. Terminal in v1: a new request is refused (409); rework needs a separately approved future version. |

**Legal transitions:**

| Before | Event | After |
|---|---|---|
| `NO_RESOLUTION_REQUEST` | `REQUEST_INTERNAL_RESOLUTION` (exact verified basis) | `AWAITING_RESOLUTION_DECISION` |
| `AWAITING_RESOLUTION_DECISION` | `DECIDE_INTERNAL_RESOLUTION` with `CONFIRM_INTERNAL_RESOLUTION` | `RESOLVED_INTERNAL` |
| `AWAITING_RESOLUTION_DECISION` | `DECIDE_INTERNAL_RESOLUTION` with `RETURN_FOR_REWORK` and a reason | `RETURNED_FOR_REWORK` |

**Refused transitions (409, no event, no audit):**
- a request without the exact verified basis, or naming another A8.6 work event of this intake;
- a second request while one awaits a decision;
- a decision when nothing is pending, or of another request;
- a decision by the request's own membership or user;
- any event after `RESOLVED_INTERNAL` or `RETURNED_FOR_REWORK`.

The disposition answers:
- `state`, `verificationEventId` (the intake's verified A8.6 record, or null), `request` and `decision`;
- `eventCount` and `lastSequence`;
- `evaluatedAt`, the database read time.

A historical decision is never recomputed from present permissions or present source status.

## Record (D3)

**Table:** `exception_resolution_events`.

**Columns:**
- `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`, `sequence`, `event_code`;
- `verification_event_id` (request only), `request_event_id` (decision only);
- `reason_code`, `decision_code`, `return_reason_code`;
- `recorded_by_membership_id`, `recorded_by_user_id`, `recorded_at`, `created_at`.

The A8.6 verification row itself carries its approved A8.5 plan, so no further basis column is needed: the plan is
proven through the RESTRICT key to that row.

**Keys and checks:**
- Every foreign key is ON DELETE RESTRICT: intake, organization, Claim, the A8.6 verification event, the request event
  (self), membership and user.
- UNIQUE (`exception_intake_id`, `sequence`) and UNIQUE (`request_event_id`), so there is at most one decision per
  request.
- CHECKs pin the contract, a positive sequence, the two events and each event's exact shape and vocabulary.

**The insert guard holds:**
- database time;
- the parent's organization and Claim;
- the acting membership;
- the intake being currently assigned by its latest A8.2 event;
- the verified basis: an A8.6 `VERIFY_WORK_REPORT` with `EVIDENCE_SUPPORTED` of exactly this intake, organization and
  Claim, the only A8.6 verification of the intake, whose approved plan is a `PROPOSE_ACTION` of this intake approved by
  an A8.5 `APPROVE_PROPOSAL` review;
- for a request: the assignee, both role permissions, the exact basis and no pending request;
- for a decision: the decide permission, the pending request, independence from the requester and the basis still
  holding;
- the terminal states and a contiguous sequence.

The table is append-only (UPDATE, including a no-op, and DELETE refused) and cannot be truncated, including
TRUNCATE ... CASCADE. No A1–A8.6 or CRG table is altered.

## Transaction (D9)

One SERIALIZABLE transaction per event:
1. The Claim row is locked first, NOWAIT. A busy Claim is waited for outside the transaction within 30 s.
2. The A8.1 intake, the A8.2 disposition, the A8.3 history, the A8.5 disposition and the A8.6 disposition and history
   are re-read through their owners on the same client.
3. The actor is judged.
4. The history is derived by the pure reducer against the verified basis.
5. The cited verification or request is verified.
6. Exactly one event and one audit are written.

**On failure:**
- A serialization failure, deadlock or unique collision is retried at most three times, each on a fresh transaction
  that re-reads everything.
- An unknown commit outcome is reconciled against the committed history and answered 409 with what that history holds.
  It is never retried blindly and never reported as success. There is no idempotency key.

Reads run in one READ ONLY snapshot; a corrupt or unsupported history is 409, never a partial view.

## Approved decisions (D1–D10, 2026-11-10)

- **D1. Names.** As specified: contract `A8-RESOLUTION-DECISION-1`, table `exception_resolution_events`, module
  `exception-resolution`, permissions `exceptionResolution.request` / `.decide` (Admin) and `.read` (Admin, Viewer),
  audit `exception_resolution.recorded`, exactly the three routes above.
- **D2. Return.** `RETURNED_FOR_REWORK` is terminal in v1 (architecture owner correction 1). The original proposal's
  "a new request after a return needs a NEW verified A8.6 record" cannot arise in v1, because A8.5 approval and A8.6
  verification are themselves terminal; it is left to a separately approved future version.
- **D3. Schema.** One additive migration, the columns above, no stored status, current or latest.
- **D4. Basis and requester.** `verificationEventId` is exactly A8.6 `verification.workEventId` with A8.6 in
  `VERIFIED_INTERNAL_WORK`, on the same approved A8.5 plan, Claim, intake and organization; the requester as above.
- **D5. Decider** as above.
- **D6. Re-check.** A decision re-checks the request's recorded basis and the decider's authority on one transaction.
- **D7. Error codes** as above.
- **D8. States** derived, never stored.
- **D9. Transactions** as above.
- **D10. Harness.** `test:a8:exception-resolution`, T001–T130, nesting `test:a8:remediation-work` (A8.6 → A1). The
  expected A8.6 branch-only N/A list is T001, T003, T010, T110, T127 and T129, each with a cause proof; for T110 every
  nested A8.5 item is re-proved on this branch down to A7.9. T120 keeps every original nested FAIL line, verbatim, in
  `a87-nested-evidence-<runId>.log` (SHA-256 in T129), each with its category: BRANCH, HEAD, SCOPE or AGGREGATE. T125
  also requires zero pg `client.query()` concurrent-query deprecation warnings in this process and in every process
  of the nested chain.

The read permissions are five, not three as the first proposal said: the A8.6 owner already requires four upstream
reads plus its own, and A8.7 requires all five (architecture owner correction 2).

## Out of scope (handoff)

The following stay out of A8.7 and belong to later, separately approved packages:
- executing any A8.5 action or correcting a Claim;
- reopening a `RESOLVED_INTERNAL` decision, rework after `RETURNED_FOR_REWORK`, and broader exception closure;
- queues, SLAs, escalation and exports;
- any Claim, A2–A7 or CRG write;
- payer and payment facts and any transmission;
- any CRG activation, Checkpoint C, and A9.

Production use additionally needs the A10 release gates.
