# A8.5 Exception Remediation — Contract Register (A8-REMEDIATION-PLAN-1)

A8.5 (contract `A8-REMEDIATION-PLAN-1`) records a controlled, evidence-linked proposed next action for one A8.1
exception intake, and an independent human review decision about it. Each proposal and each review is one append-only
event in a server-numbered sequence. The remediation disposition is never stored: it is derived from the exact sequence
on every read.

An approval is **internal planning authorization only**. A8.5 never does any of the following:

- execute, correct, resolve, close or escalate anything;
- assert a payer, patient, payment or financial outcome;
- change the intake, its triage or investigation history, the Claim or any source record.

## Start gate and index decision

- **Predecessor.** A8.3 was merged as PR #101 at `a9f15806f4a178250b4aa263874a2b5c17ba827c`. The branch
  `feature/a8-5-exception-remediation` is cut from clean, synchronized main `c8ebf2c4cc385dadeaacafca0bca69db5c534b7a`
  (CRG-01 Checkpoint A, PR #103), which contains that merge. It is not stacked on a feature branch.
- **A8.4 is closed and A8.5 is the next index.** On 2026-11-04 the architecture owner closed the earlier A8.4
  investigation-evidence specification as a duplicate of A8.3. It is not executable. Any later idea from it needs a
  separately approved, versioned A8.3 extension. A8.5 is the approved next A8 index.
- **CRG-01 is independent.** A8.5 does not touch CRG-01's branch, its synthetic coding-release work or its activation
  gates. `RECHECK_CODING_REFERENCE` is an internal request for review only. It selects no code set, changes no A2, A3 or
  A5 record, triggers no Checkpoint B and implies no DHA compliance.
- **Accepted interfaces used here, unchanged:**
  - A8.1 `getExceptionIntakesOf(claimId, tx)`;
  - A8.2 `getTriageDispositionOf(claimId, exceptionIntakeId, tx)`, with `dispositionCode`, `assignedMemberId` and
    `assigneeCurrentlyEligible` (A1 effective permissions grant `exceptionTriage.record`);
  - A8.3 `getInvestigationHistoryOf(claimId, exceptionIntakeId, tx)` and its `RECORD_FINDING` events;
  - the A6.7 Claim ownership path;
  - the Claim row lock taken first by every A8 write.
- **Decisions.** Names, contract and vocabulary as specified. The head developer's decisions R1–R8 and S1–S4
  (2026-11-05) are listed below.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/remediation-events` | `exceptionIntake.read` + `exceptionTriage.read` + `exceptionInvestigation.read`, plus the event's own permission: `exceptionRemediation.propose` for a proposal or `exceptionRemediation.review` for a review (Admin) | 201 with the recorded event |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/remediation-history` | the three read permissions + `exceptionRemediation.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/remediation-disposition` | the three read permissions + `exceptionRemediation.read` (Admin, Viewer) | 200, the derived disposition |

**Error answers:**

| Situation | Answer |
|---|---|
| No session | 401 |
| A missing permission | 403 |
| A Claim, intake or finding of another organization, Claim or intake | 404, the same as a missing one |
| A malformed id or body | 400 |
| A proposer who is not the current, eligible assignee holding the proposal permission | 409 `EXCEPTION_REMEDIATION_NOT_ASSIGNEE` |
| A reviewer without the review permission now, or the proposal's own author | 409 `EXCEPTION_REMEDIATION_REVIEWER_NOT_INDEPENDENT` |
| An event that is not a legal next step | 409 `EXCEPTION_REMEDIATION_TRANSITION_REFUSED` |
| A conflicting or uncertain write, or an inconsistent stored history | 409 `EXCEPTION_REMEDIATION_CONFLICT` |

- The GETs accept no query or body.
- There is no PUT, PATCH or DELETE, no collection, cross-Claim search or queue, and no execution, correction,
  resolution, closure, escalation or export route.
- Audit `exception_remediation.recorded` (entity `EXCEPTION_REMEDIATION_EVENT`) is written exactly once per recorded
  event, in the same transaction, metadata only.
- The reader for a future owner is `getRemediationDispositionOf(claimId, exceptionIntakeId, tx)`. It reads on the
  caller's transaction and opens none of its own.

## Who may write

**Proposer.** The member to whom the exception is presently assigned in A8.2, and only while:

- the A8.2 disposition is `ASSIGNED` to exactly the acting user's membership of the organization;
- that assignment is still eligible under the accepted A8.2 policy (`assigneeCurrentlyEligible`);
- the membership holds `exceptionRemediation.propose` now.

Not every Admin may propose.

**Reviewer.** A member of the same organization, and only while:

- the membership holds `exceptionRemediation.review` now (checked at review time);
- the membership and the user both differ from the outstanding proposal's author, so there is no self-review and no
  proxy actor;
- the exception is still `ASSIGNED` (R3).

**What blocks a new write.** A return to triage, a reassignment to another member or a lost role blocks new proposals
until a valid A8.2 reassignment. A lost review role blocks a review. A historical event is never rewritten.

## Events (v1)

The request is exactly one event code and its own controlled fields; anything else is a 400. The server derives the
actor and membership, the organization, the Claim, the sequence and the time.

| eventCode | Request fields | Rule |
|---|---|---|
| `PROPOSE_ACTION` | `actionCode`, `findingEventId`, `rationaleCode` | The finding is an A8.3 `RECORD_FINDING` event of exactly this intake, Claim and organization. An evidence link alone supports no proposal (409). Another intake's or tenant's event is the same 404 as a missing one. |
| `REVIEW_ACTION` | `proposalEventId`, `decisionCode`, and `reviewReasonCode` exactly when the decision is `RETURN_PROPOSAL` | The proposal is exactly the one that awaits review. |

**Controlled values:**
- `actionCode`: `REVIEW_SOURCE_PROVENANCE`, `REQUEST_INTERNAL_DOCUMENTATION_CHECK`, `RECHECK_CODING_REFERENCE`,
  `REFER_FOR_POLICY_REVIEW`.
- `rationaleCode`: `RECORDED_CONFLICT`, `INSUFFICIENT_EVIDENCE`, `POLICY_CLARIFICATION_NEEDED`.
- `decisionCode`: `APPROVE_PROPOSAL`, `RETURN_PROPOSAL`.
- `reviewReasonCode` (RETURN only): `INSUFFICIENT_SUPPORT`, `WRONG_SCOPE`, `NEEDS_MORE_INVESTIGATION`.

## Derived disposition

| State | Meaning |
|---|---|
| `NO_PROPOSAL` | No event (zero rows; nothing stored) |
| `AWAITING_REVIEW` | The latest event is a proposal; `pendingProposal` names it |
| `RETURNED_FOR_REVISION` | The latest event returned the proposal; a fresh proposal may follow |
| `APPROVED_FOR_PLANNING` | The latest event approved the proposal. This is terminal for a v1 intake, and approval only authorizes planning. |

**Refused transitions:**
- a second proposal while one awaits review;
- a review when nothing is outstanding, or a review of another proposal;
- a review by the proposal's author;
- any event after an approval;
- a proposal that repeats the just-returned proposal unchanged (same action, finding and rationale). A fresh proposal
  must differ (S2).

The disposition answers:
- `state`, `pendingProposal` and `latestDecision`;
- `approvedProposalEventId`, `proposalCount`, `eventCount` and `lastSequence`;
- `evaluatedAt`, the database read time.

## Record

**Table:** `exception_remediation_events`.

**Columns:**
- `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`, `sequence`, `event_code`;
- `action_code`, `a8_3_finding_event_id`, `rationale_code`, `proposal_event_id`, `decision_code`,
  `review_reason_code`;
- `recorded_by_membership_id`, `recorded_by_user_id`, `recorded_at`, `created_at`.

**Keys and checks:**
- Every foreign key is ON DELETE RESTRICT: intake, organization, Claim, A8.3 finding event, proposal event (self),
  membership and user.
- UNIQUE (`exception_intake_id`, `sequence`) and UNIQUE (`proposal_event_id`), so there is one review per proposal.
- CHECKs pin the contract, a positive sequence, the two events and each event's exact shape and vocabulary.

**The insert guard holds:**
- database time;
- the parent's organization and Claim;
- the acting membership;
- the intake being currently assigned by its latest A8.2 event;
- for a proposal: the assignee, both role permissions and an A8.3 `RECORD_FINDING` of this intake;
- for a review: the review permission and independence from the author;
- the outstanding proposal, an approval being terminal, the unchanged-repeat rule and a contiguous sequence.

The table is append-only (UPDATE and DELETE refused) and cannot be truncated. No A1–A8.3 table is altered.

## Transaction

One SERIALIZABLE transaction per event:
1. The Claim row is locked first, NOWAIT. A busy Claim is waited for outside the transaction within 30 s.
2. The A8.1 intake, the A8.2 disposition and the A8.3 history are re-read through their owners.
3. The actor is judged.
4. The history is derived by the pure reducer.
5. The finding is verified.
6. Exactly one event and one audit are written.

**On failure:**
- A serialization failure, deadlock or unique collision is retried at most three times, each on a fresh transaction
  that re-reads everything.
- An unknown commit outcome is reconciled against the committed history and answered 409 with what that history holds.
  It is never retried blindly and never reported as success. There is no idempotency key.

## Head-developer decisions (2026-11-05)

- **R1. Names.** As specified: contract `A8-REMEDIATION-PLAN-1`, table `exception_remediation_events`, module
  `exception-remediation`, audit `exception_remediation.recorded`.
- **R2. Permissions.** `exceptionRemediation.propose` (Admin), `exceptionRemediation.review` (Admin) and
  `exceptionRemediation.read` (Admin, Viewer).
- **R3. Review only while assigned.** A pending proposal is reviewed only while the exception is ASSIGNED.
- **R4. Supporting finding.** It may be any A8.3 finding code of this intake. A fresh proposal may reuse the same
  finding.
- **R5. Repeats and unknown outcomes.** There is no idempotency key; an exact repeat is refused, and an unknown outcome
  is reconciled (as for A8.2 and A8.3).
- **R6. Database guard.** The guard is the second line of defence for every rule above.
- **R7. Index decision.** The A8.4 closure and the A8.5 index are recorded here.
- **R8. Database.** No database juggling: PR #103 was merged first.
- **S1. Route permissions.** The route checks the event's own permission, so a Viewer gets 403.
- **S2. Fresh proposals.** A fresh proposal after a return must differ from the returned one.
- **S3. Self-review is a corrupt history.** The reducer also refuses self-review, so a planted self-review fails the
  whole read.
- **S4. Read-only page.** The developer page is read only. It renders codes from the DTO and holds no vocabulary
  literals.

## Out of scope (handoff)

The following stay out of A8.5 and belong to later, separately approved packages:
- executing the approved action;
- any actual correction, resolution, closure or escalation;
- SLA, export and A9 integration.

Production use additionally needs the A10 release gates.
