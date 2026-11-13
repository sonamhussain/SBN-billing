# A8.8 Exception Escalation & Follow-up Governance — Contract Register (A8-ESCALATION-1)

A8.8 (contract `A8-ESCALATION-1`) records a controlled **internal escalation and follow-up trail** for one A8.1 exception
that still needs human attention. The current A8.2 assignee escalates the exception to one nominated member of the same
organization; only that member acknowledges it and records typed follow-ups, each citing one exact A8.3 or A8.6 record
of the same exception; a member independent of the escalator, the nominated member and the current assignee returns it
to its owner. Each step is one append-only event in a server-numbered sequence. The escalation disposition is never
stored: it is derived from the exact sequence on every read.

Escalation means **INTERNAL HANDOFF** only. It is not an emergency or clinical priority and not a payer status. A8.8
never does any of the following:

- execute the remediation, make a new A8.3 finding, approve an A8.5 plan again or re-verify A8.6 work;
- overwrite, reopen or override an A8.7 resolution, or escalate a `RESOLVED_INTERNAL` exception;
- close the exception, reassign it (the A8.2 assignment is unchanged by a return), or decide clinical or financial
  truth;
- contact a payer, or change the Claim, any A2–A7 or CRG record, or any source record.

## Start gate

- **Predecessors.** A8.5 was merged as PR #104 at `0f8f9d3bc18347b1360b72b93056724b594a6e00`. A8.6 was merged as PR #106
  at `18de6c81f9f47374d011cfe9a688b500b8c17beb`. A8.7 received FINAL PASS and was merged as PR #107 at
  `8af18916428bf173d87c33653ed8350c75c1edcb`; its tree is identical to the accepted HEAD `194430b`.
- **Branch.** `feature/a8-8-exception-escalation-followup` is cut from clean, synchronized main
  `8af18916428bf173d87c33653ed8350c75c1edcb` (the A8.7 merge), which contains all three merges. It is not stacked on a
  feature branch.
- **A8.4 stays closed.** On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of
  A8.3. No A8.4 code exists.
- **CRG-01 is independent.** A8.8 writes no CRG record, enables no real DHA/DOH scope, imports nothing, selects no coding
  release and sets no regulatory PASS. No Checkpoint C work is part of A8.8.
- **Reconciliation with accepted A8.7.** Before implementation the prepared specification was reconciled with the
  accepted A8.7 interfaces and terminal states, as the architecture owner required. The scope request is recorded in
  `A8.8_reconciliation_draft.md` (decisions D1–D8 below). A8.8 reads A8.7 only through its accepted reader and adds no
  state that overrides `RESOLVED_INTERNAL` or `RETURNED_FOR_REWORK`.
- **Accepted interfaces used here, unchanged:**
  - A8.1 `getExceptionIntakesOf(claimId, tx)`;
  - A8.2 `getTriageDispositionOf(claimId, exceptionIntakeId, tx)` (`dispositionCode`, `assignedMemberId`,
    `assigneeCurrentlyEligible`) and `getTriageHistoryOf`;
  - A8.3 `getInvestigationHistoryOf(claimId, exceptionIntakeId, tx)`;
  - A8.5 `getRemediationDispositionOf` and `getRemediationHistoryOf`;
  - A8.6 `getWorkHistoryOf(claimId, exceptionIntakeId, tx)`;
  - A8.7 `getResolutionDispositionOf(claimId, exceptionIntakeId, tx)` (its `state`) and `getResolutionHistoryOf`;
  - the A6.7 Claim ownership path, the A1 effective permissions of a member;
  - the Claim row lock taken first by every A8 write.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/escalation-events` | the six upstream reads (`exceptionIntake.read`, `exceptionTriage.read`, `exceptionInvestigation.read`, `exceptionRemediation.read`, `exceptionRemediationWork.read`, `exceptionResolution.read`), plus the event's own permission: `exceptionEscalation.raise` (escalate), `exceptionEscalation.handle` (acknowledge, follow up) or `exceptionEscalation.review` (return) (Admin) | 201 with the recorded event |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/escalation-history` | the six read permissions + `exceptionEscalation.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/escalation-disposition` | the six read permissions + `exceptionEscalation.read` (Admin, Viewer) | 200, the derived disposition |

**Error answers:**

| Situation | Answer |
|---|---|
| No session | 401, before any lookup |
| A missing permission | 403 |
| A Claim, intake, nominated member or cited source of another organization, Claim or intake, or a missing one | 404, identical |
| A malformed id or body, a query, or an unknown field or code | 400 `VALIDATION_ERROR` |
| An escalator who is not the current, eligible assignee holding `exceptionTriage.record` and `.raise` | 409 `EXCEPTION_ESCALATION_NOT_ASSIGNEE` |
| A nominated member who is not eligible now (handle and the six reads), an acknowledger or follow-up author who is not the nominated member, or who is the current assignee | 409 `EXCEPTION_ESCALATION_TARGET_NOT_ELIGIBLE` |
| An escalator nominating or acknowledging itself; a returning reviewer without `.review`, or who is the escalator, the nominated member or the current assignee | 409 `EXCEPTION_ESCALATION_NOT_INDEPENDENT` |
| A follow-up citing a record of this exception that is not an A8.3 or A8.6 event (its intake, an A8.2, A8.5, A8.7 or A8.8 event) | 409 `UNSUPPORTED_REFERENCE` |
| An event that is not a legal next step now, including while A8.7 awaits a decision or once it is `RESOLVED_INTERNAL`, or while the exception is not assigned | 409 `EXCEPTION_ESCALATION_TRANSITION_REFUSED` |
| A conflicting or uncertain write, or an inconsistent stored or owner history | 409 `EXCEPTION_ESCALATION_CONFLICT` |

- The GETs accept no query or body.
- There is no PUT, PATCH or DELETE, no list-all, search, collection, queue, job, SLA, timer, current or sequence
  selector, and no executor, claim adjustment, release, resolution, closure, reopen, export, payer or transmission route.
- Audit `exception_escalation.recorded` (entity `EXCEPTION_ESCALATION_EVENT`) is written exactly once per recorded
  event, in the same transaction, metadata only. A refusal and every read write nothing.
- The reader for a future owner is `getEscalationDispositionOf(claimId, exceptionIntakeId, tx)`. It reads on the
  caller's transaction and opens none of its own.

## Who may write (D3, D4)

Every write needs the exception **ASSIGNED** by its latest A8.2 event at that moment. A reassignment does not cancel an
escalation; a return to triage pauses it (writes are refused until it is assigned again).

**Escalator.** The member to whom the exception is presently assigned in A8.2: `ASSIGNED` to exactly the acting user's
membership, still eligible under the accepted A8.2 policy, holding `exceptionTriage.record` and
`exceptionEscalation.raise` now.

**Nominated member (target).** A membership of the same organization, never the escalator's, whose roles grant
`exceptionEscalation.handle` and all six upstream reads at the moment of the escalation and of each of its own events,
and who is not the current assignee at that moment. Only this member acknowledges the escalation and records its
follow-ups; a follow-up is recorded by the same user who acknowledged it.

**Returning reviewer.** A member holding `exceptionEscalation.review` now, whose membership and user both differ from
the escalator's, the nominated member's and the acknowledger's, and who is not the current assignee.

The service, the route and the database guard all enforce these rules. There is no Admin override, no timer and no
automatic event from any other owner.

## Events (v1)

The request is exactly one event code and its own controlled fields; anything else is a 400. The server derives the
actor and membership, the organization, the Claim, the sequence, the time and the source kind.

| eventCode | Request fields | Rule |
|---|---|---|
| `ESCALATE_FOR_REVIEW` | `reasonCode`, `targetMemberId` | No escalation of the intake exists; the escalator and target as above; A8.7 permits it. |
| `ACKNOWLEDGE_ESCALATION` | `escalationEventId` | Names exactly the open escalation, not yet acknowledged; by the nominated member. |
| `RECORD_FOLLOWUP` | `acknowledgementEventId`, `followupCode`, `sourceEventId` | Names exactly the escalation's acknowledgement; by the nominated member who acknowledged it; the source is an exact A8.3 or A8.6 event of this intake; not a duplicate (same code citing the same record). |
| `RETURN_TO_OWNER` | `escalationEventId`, `returnReasonCode` | Names exactly the escalation, acknowledged and with at least one follow-up; by an independent reviewer. |

**Controlled values (codes are internal metadata only; no free text):**
- `reasonCode`: `NEEDS_SUPERVISOR_REVIEW`, `EVIDENCE_INCOMPLETE`, `POLICY_GUIDANCE_REQUIRED`.
- `followupCode`: `SOURCE_RECHECK_RECORDED`, `ADDITIONAL_INFORMATION_REQUESTED`, `INTERNAL_POLICY_REVIEWED`.
- `returnReasonCode`: `FOLLOWUP_RECORDED`, `FURTHER_WORK_REQUIRED`.
- `sourceEventKind` (stored, server-owned): `INVESTIGATION_EVIDENCE_LINK` (A8.3 `LINK_EVIDENCE_REFERENCE`),
  `INVESTIGATION_FINDING` (A8.3 `RECORD_FINDING`), `WORK_REPORT` (A8.6 `RECORD_WORK_REPORT`), `WORK_VERIFICATION` (A8.6
  `VERIFY_WORK_REPORT`).

`POLICY_GUIDANCE_REQUIRED` and `INTERNAL_POLICY_REVIEWED` are internal notes only: they set no regulatory PASS, start no
code-set import and bypass no A5 validation.

## The A8.7 gate (D1)

| A8.7 state | `ESCALATE_FOR_REVIEW` | Acknowledge, follow up or return an open escalation |
|---|---|---|
| `NO_RESOLUTION_REQUEST` | allowed | allowed |
| `AWAITING_RESOLUTION_DECISION` | refused 409 | refused 409 while pending; allowed again if A8.7 returns the request |
| `RETURNED_FOR_REWORK` (terminal) | allowed | allowed |
| `RESOLVED_INTERNAL` (terminal) | refused 409; never escalated | refused 409; the escalation stays as recorded |
| unreadable or inconsistent | 409, fail closed | 409, fail closed |

A8.7 is accepted and unchanged, so it may still move to pending or resolved while an escalation is open; A8.8 therefore
re-reads A8.7 on every write instead of blocking it. The A8.8 disposition adds no field or state for this: the A8.7
state is read from A8.7.

## Derived disposition

| State | Meaning |
|---|---|
| `NO_ESCALATION` | No event (zero rows; nothing stored). |
| `AWAITING_ACKNOWLEDGEMENT` | The escalation is recorded; `escalation` names its reason and nominated member. |
| `FOLLOWUP_ACTIVE` | The nominated member acknowledged it; `followups` lists every recorded follow-up in order. |
| `RETURNED_TO_OWNER` | An independent reviewer returned it with its reason. Terminal in v1. |

**Legal transitions:**

| Before | Event | After |
|---|---|---|
| `NO_ESCALATION` | `ESCALATE_FOR_REVIEW` | `AWAITING_ACKNOWLEDGEMENT` |
| `AWAITING_ACKNOWLEDGEMENT` | `ACKNOWLEDGE_ESCALATION` by the nominated member | `FOLLOWUP_ACTIVE` |
| `FOLLOWUP_ACTIVE` | `RECORD_FOLLOWUP` by the nominated member | `FOLLOWUP_ACTIVE` (one more recorded step) |
| `FOLLOWUP_ACTIVE` with at least one follow-up | `RETURN_TO_OWNER` by an independent reviewer | `RETURNED_TO_OWNER` |

**Refused transitions (409, no event, no audit):**
- a second escalation while one is pending or active (one cycle per intake in v1);
- an acknowledgement without an escalation, of another escalation, by the escalator, by another member or a second time;
- a follow-up before the acknowledgement, of another acknowledgement, by anyone but the acknowledging nominated member,
  or an exact duplicate;
- a return before a follow-up, of another escalation, or by the escalator, the nominated member or the current assignee;
- every event after `RETURNED_TO_OWNER`.

The disposition answers `state`, `escalation`, `acknowledgement`, `followups`, `returned`, `eventCount`, `lastSequence`
and `evaluatedAt` (the database read time). A historical event is never recomputed from present permissions.

**v1 consequence.** An exception with A8.7 `RETURNED_FOR_REWORK` and A8.8 `RETURNED_TO_OWNER` has no further governed
path in v1. A further escalation cycle needs a separately versioned policy and is not part of this build.

## Record

**Table:** `exception_escalation_events`.

**Columns:**
- `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`, `sequence`, `event_code`;
- `reason_code`, `target_member_id` (escalation only);
- `escalation_event_id` (acknowledgement and return), `acknowledgement_event_id` (follow-up);
- `followup_code`, `source_event_id`, `source_event_kind` (follow-up only), `return_reason_code` (return only);
- `recorded_by_membership_id`, `recorded_by_user_id`, `recorded_at`, `created_at`.

**Keys and checks:**
- Every foreign key is ON DELETE RESTRICT: intake, organization, Claim, the nominated membership, the escalation and
  acknowledgement events (same table), the recording membership and user.
- The cited source is held by the insert guard against its owning A8.3 or A8.6 table (D6): same intake, organization
  and Claim, and the event code its kind names. Those tables are append-only, so a cited record cannot disappear; no
  foreign UUID is accepted.
- UNIQUE (`exception_intake_id`, `sequence`); UNIQUE (`exception_intake_id`, `event_code`) for the escalation, the
  acknowledgement and the return, so one cycle per intake; UNIQUE (`exception_intake_id`, `followup_code`,
  `source_event_id`) for follow-ups.
- CHECKs pin the contract, a positive sequence, the four events and each event's exact shape and vocabulary.

**The insert guard holds:**
- database time; the parent's organization and Claim; the acting membership;
- the intake being currently assigned by its latest A8.2 event;
- the A8.7 state (no pending request, not confirmed);
- for an escalation: the assignee, both role permissions, no earlier escalation, a same-organization nominated member
  who is not the escalator and holds handle and the six reads;
- for an acknowledgement or follow-up: the nominated member, eligible now, not the escalator and not the current
  assignee; the exact escalation or acknowledgement; for a follow-up the acknowledging user and the exact source;
- for a return: the review permission, independence from the escalator, the nominated member, the acknowledger and the
  current assignee, the exact escalation, an acknowledgement and at least one follow-up;
- the terminal state and a contiguous sequence.

The table is append-only (UPDATE, including a no-op, and DELETE refused) and cannot be truncated, including
TRUNCATE ... CASCADE. No A1–A8.7 or CRG table is altered.

## Transaction

One SERIALIZABLE transaction per event:
1. The Claim row is locked first, NOWAIT. A busy Claim is waited for outside the transaction within 30 s.
2. The A8.1 intake and the A8.2 disposition are re-read, and the actor's membership is judged.
3. The A8.3, A8.5, A8.6 and A8.7 owners are read on the same client; A8.7's gate is applied.
4. The history is derived by the pure reducer.
5. The nominated member or cited source is resolved, the step is judged, and present eligibility is checked.
6. Exactly one event and one audit are written.

**On failure:**
- A serialization failure, deadlock or unique collision is retried at most three times, each on a fresh transaction
  that re-reads every owner.
- An unknown commit outcome is reconciled against the committed history and answered 409 with what that history holds.
  It is never retried blindly and never reported as success. There is no idempotency key.

Reads run in one READ ONLY snapshot; a corrupt, gapped, foreign or unknown-contract history is 409, never a partial view.

## Implementation decisions (D1–D8, 2026-11-11)

- **D1. A8.7 gate** as above.
- **D2. Six upstream reads** on every route, following the A8.7 correction.
- **D3. Actors** as above, including the returning reviewer's independence from the escalator, the nominated member and
  the current assignee.
- **D4. A8.2 changes.** Every write needs the intake assigned now; a reassignment does not cancel the escalation.
- **D5. Follow-up sources.** The four kinds above, any follow-up code with any kind; a source may predate the
  acknowledgement; no duplicate (code, source) in one escalation.
- **D6. Source storage** as specified: `source_event_id` plus `source_event_kind`, held by the insert guard.
- **D7. Error codes** as above.
- **D8. Literals** frozen as specified; one cycle per intake; one acknowledgement and one return, enforced by unique
  indexes.
- **Harness.** `test:a8:exception-escalation`, T001–T130, nesting `test:a8:exception-resolution` (A8.7 → A1). T120 keeps
  every original nested FAIL line, verbatim, in `a88-nested-evidence-<runId>.log` (SHA-256 in T129), each with its
  category: BRANCH, HEAD, SCOPE or AGGREGATE. T127 also requires zero pg `client.query()` concurrent-query deprecation
  warnings in this process and in every process of the nested chain.

## A6.10 T087 later-phase recognition (included in this PR)

The first full A8.8 clone proof found one regression that is not a defect of A8.8. The accepted A6.10 suite's T087 ("No payer send") scans every column of the database for a payer-send name, `acknowledg…` among them. It therefore read A8.8's specified column `exception_escalation_events.acknowledgement_event_id`, the internal acknowledgement of an escalation, as a payer acknowledgement. That one FAIL reached every suite above A6.10 in the nested chain.

The column keeps its specified name: renaming it to avoid an old check is not allowed. At the head developer's decision, the correction is made in this PR rather than in a separate corrective PR:

- A6.10's T087 now skips the columns of tables created by migrations committed after A6.10's own merge. This is the later-phase rule A6.10 already applies to its table check, moved up so that T087 can use it.
- Every column that existed when A6.10 merged is judged exactly as before. On A6.10's own branch the later-phase set is empty, so the predicate is the original one.
- No A6.10 check id, title or other predicate changed.

A8.8's own T009 and T010 prove that this is the only change to an earlier suite: one code line removed and one added, and every A6.10 check id and title unchanged.

## Out of scope (handoff)

The following stay out of A8.8 and belong to later, separately approved packages:
- executing any remediation, correcting a Claim, or reassigning an exception;
- a second escalation cycle, reopening, governed exception closure or reconstruction (A8.9+);
- queues, SLAs, timers, automatic escalation and exports;
- any Claim, A2–A7 or CRG write; ICD-10-CM, CPT, HCPCS Level II, modifier, release-right or service-date coding;
- payer and payment facts, remittance, DRG and any transmission;
- any CRG activation, Checkpoint B/C, real DHA activation, and A9.

Production use additionally needs the A10 release gates.
