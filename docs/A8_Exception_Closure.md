# A8.9 Internal Exception Closure & Historical Reconstruction — Contract Register (A8-CLOSURE-1)

A8.9 (contract `A8-CLOSURE-1`) records a deliberately authorized, evidence-linked **final internal process closure** for
one A8.1 exception intake. It also reconstructs, read-only, the exact historical basis that justified the closure. One
human confirmation is one append-only event. The closure disposition is never stored: it is derived on every read.

`CLOSED_INTERNAL` means only that SBN's internal exception handling reached an approved terminal position. It is never
any of the following:

- a clinical determination;
- a payer adjudication or a resolved external claim;
- a remittance, a financial settlement or a payment outcome;
- a code-set compliance attestation.

A closure is never inferred from A8.6 `VERIFIED_INTERNAL_WORK` or from an A8.8 `RETURNED_TO_OWNER`. It requires the
explicit A8.7 `RESOLVED_INTERNAL` decision and a human confirmation. It changes nothing in the intake, its triage,
investigation, remediation, work, resolution or escalation history, the Claim, any A2–A7 or CRG record, or any source
record.

## Start gate

- **Predecessors.**
  - A8.5 was merged as PR #104 at `0f8f9d3bc18347b1360b72b93056724b594a6e00`.
  - CRG-01 Checkpoint B was merged as PR #105 at `4869df3c81ac4af5dcec988768666f7acd3d809e`.
  - A8.6 was merged as PR #106 at `18de6c81f9f47374d011cfe9a688b500b8c17beb`.
  - A8.7 was merged as PR #107 at `8af18916428bf173d87c33653ed8350c75c1edcb`.
  - A8.8 was merged as PR #108 at `012d6fd92b3b1990ff72a662a33a9a800328a9b6`.
- **Branch.** `feature/a8-9-closure-and-reconstruction` is cut from clean, synchronized main containing every merge
  above. It is not stacked on a feature branch.
- **A8.4 stays closed.** On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of
  A8.3. No A8.4 code exists.
- **CRG-01 is independent.** A8.9 reads historical coding status through its owner only. It enables no real DHA/DOH
  scope, imports nothing and selects no coding release. Checkpoint C, A9, A10 and A11 stay separate.
- **Reconciliation.** The specification was reconciled with the accepted A8.7 and A8.8 interfaces and terminal states,
  and the scope questions were sent to the architecture owner.
- **Architecture approval (2026-11-13).** The architecture owner approved the contract `A8-CLOSURE-1` and the
  architecture, with CL-01, CL-02 and D1 as recorded below. The following were also approved:
  - the seven upstream read permissions;
  - the current A8.2 assignment requirement;
  - a single closure per intake;
  - the append-only history;
  - the read-only historical reconstruction.
- **Accepted interfaces used here, unchanged:**
  - A8.1 `getExceptionIntakesOf(claimId, tx)`.
  - A8.2 `getTriageDispositionOf` and `getTriageHistoryOf`.
  - A8.3 `getInvestigationHistoryOf`.
  - A8.5 `getRemediationDispositionOf` and `getRemediationHistoryOf`.
  - A8.6 `getWorkDispositionOf` and `getWorkHistoryOf`.
  - A8.7 `getResolutionDispositionOf` and `getResolutionHistoryOf`.
  - A8.8 `getEscalationDispositionOf` and `getEscalationHistoryOf`.
  - The A6.7 Claim ownership path and the Claim's frozen submissions; the CRG coding status of a frozen submission as
    recorded (`VERIFIED_AS_RECORDED` or `LEGACY_PROVENANCE_UNVERIFIED`); the A1 effective permissions of a member.
  - The Claim row lock taken first by every A8 write.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/closure-events` | the seven upstream reads (`exceptionIntake.read`, `exceptionTriage.read`, `exceptionInvestigation.read`, `exceptionRemediation.read`, `exceptionRemediationWork.read`, `exceptionResolution.read`, `exceptionEscalation.read`) + `exceptionClosure.confirm` (Admin) | 201 with the recorded closure |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/closure-history` | the seven read permissions + `exceptionClosure.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/closure-reconstruction` | the seven read permissions + `exceptionClosure.read` (Admin, Viewer) | 200, the read-only historical reconstruction |

**Error answers:**

| Situation | Answer |
|---|---|
| No session | 401, before any lookup |
| A missing permission | 403 |
| A Claim, intake, A8.7 decision or basis of another organization, Claim or intake, or a missing one | 404, identical |
| A malformed id or body, a query, an unknown field or code, or a reason or basis that does not match its kind | 400 `VALIDATION_ERROR` |
| No confirmed A8.7 resolution, a pending or returned resolution, an outstanding A8.8 escalation, a decision or basis that is not the intake's own, or an exception that is not assigned | 409 `EXCEPTION_CLOSURE_NOT_ELIGIBLE` |
| A confirmer without `exceptionClosure.confirm` now, or the A8.7 requester or decider (membership or user) | 409 `EXCEPTION_CLOSURE_NOT_INDEPENDENT` |
| Any closure after the closure (terminal in v1) | 409 `EXCEPTION_CLOSURE_TRANSITION_REFUSED` |
| A conflicting or uncertain write, or an inconsistent stored or owner history | 409 `EXCEPTION_CLOSURE_CONFLICT` |
| A reconstruction whose owner records do not anchor the recorded closure exactly | 409 `INTEGRITY_CONFLICT` |

- The GETs accept no query or body.
- There is no PUT, PATCH or DELETE.
- There is no list-all, search, bulk, job, current or sequence selector.
- There is no reopen, automatic closure, SLA, payer, payment, Claim correction, source mutation, export or transmission
  route.
- Audit `exception_closure.recorded` (entity `EXCEPTION_CLOSURE_EVENT`) is written exactly once per closure, in the same
  transaction, metadata only. A refusal and every read write nothing.

## Eligibility (§3, CL-01, CL-02)

| A8.7 | A8.8 | Closure |
|---|---|---|
| `RESOLVED_INTERNAL` | `NO_ESCALATION` | eligible: basis `RESOLUTION_DECISION` (the A8.7 confirmation), reason `VERIFIED_INTERNAL_RESOLUTION` |
| `RESOLVED_INTERNAL` | `RETURNED_TO_OWNER`, returned for `FOLLOWUP_RECORDED` | eligible (CL-01): basis `ESCALATION_RETURN` (that exact `RETURN_TO_OWNER` event), reason `TERMINAL_FOLLOWUP_REVIEWED`; the closure also names the exact A8.7 decision |
| `RESOLVED_INTERNAL` | `RETURNED_TO_OWNER`, returned for `FURTHER_WORK_REQUIRED` | refused (CL-01, v1): further work was required |
| `RESOLVED_INTERNAL` | `AWAITING_ACKNOWLEDGEMENT` or `FOLLOWUP_ACTIVE` | refused (CL-02): the escalation is outstanding |
| `AWAITING_RESOLUTION_DECISION` or `RETURNED_FOR_REWORK` | any | refused: no internal resolution |
| `NO_RESOLUTION_REQUEST`, or any unreadable or inconsistent owner history | any | refused, failing closed (409) |

These combinations are all reachable. A8.8 never escalates a resolved exception, but A8.7 can resolve an exception whose
escalation was already returned (CL-01) or is still open (CL-02).

**v1 consequences:**
- A CL-02 intake can never be closed, because A8.8 accepts no further write once A8.7 has resolved it.
- A `RETURNED_FOR_REWORK` intake can never be closed.
- An intake whose escalation was returned for `FURTHER_WORK_REQUIRED` can never be closed.
- Each needs a separately versioned future policy.

The A8.6 verification needs no separate gate: A8.7 `RESOLVED_INTERNAL` already rests on the intake's one
`EVIDENCE_SUPPORTED` verification on its approved A8.5 plan.

## Who may close (D1, D3)

A member of the owning organization, and only while all of the following hold:
- the membership holds `exceptionClosure.confirm` now;
- the membership and the user both differ from the A8.7 request's and the A8.7 decision's (independent by both user
  and membership);
- the exception is ASSIGNED by its latest A8.2 event (the confirmer need not be the assignee).

Independence from the A8.8 participants or from the current assignee is not required (D1, as approved). There is no
Admin override and no automatic closure from any other owner.

## Event (v1)

The request is exactly the event code and its own controlled fields; anything else is a 400. The server derives the
actor and membership, the organization, the Claim, the sequence, the time and the basis owner contract.

| eventCode | Request fields | Rule |
|---|---|---|
| `CONFIRM_INTERNAL_CLOSURE` | `resolutionDecisionEventId`, `closureReasonCode`, `basisReferenceKind`, `basisReferenceId` | The decision is the intake's confirmed A8.7 decision. The basis is that decision (`RESOLUTION_DECISION`) or the intake's A8.8 return (`ESCALATION_RETURN`), exactly as the eligibility table names. The reason is the one the kind names. |

**Controlled values:**
- `closureReasonCode`: `VERIFIED_INTERNAL_RESOLUTION`, `TERMINAL_FOLLOWUP_REVIEWED`.
- `basisReferenceKind`: `RESOLUTION_DECISION` (owner contract `A8-RESOLUTION-DECISION-1`), `ESCALATION_RETURN` (owner
  contract `A8-ESCALATION-1`).
- States: `NO_CLOSURE`, and `CLOSED_INTERNAL` (terminal in v1).

There is at most one closure per intake. A repeat, identical or not, is refused with 409 and writes nothing (D4). There
is no reopening in v1.

## Historical reconstruction (D6)

`GET closure-reconstruction` answers the following:
- `state`;
- `recordedClosure` (the RECORDED_CLOSURE, told apart from the upstream decisions it rests on);
- the canonical `chain`: A8.1 intake → A8.2 events → A8.3 links and findings → A8.5 plan → A8.6 report and verification
  → A8.7 request and decision → A8.8 events (if any) → A8.9 closure. Each entry has its position, owner, owner contract,
  exact record id, sequence and event code;
- `submissions`: the Claim's A6 frozen submissions, each with its CRG coding status exactly as the CRG owner reports it.
  `LEGACY_PROVENANCE_UNVERIFIED` is never upgraded, and present rights, editions, memberships or assignments never
  rewrite a recorded fact;
- `evaluatedAt`, the database read time.

**What is anchored:**
- the recorded decision is a `DECIDE_INTERNAL_RESOLUTION` in the A8.7 history;
- the basis is that decision with no escalation, or the `RETURN_TO_OWNER` in the A8.8 history;
- the A8.7 request's verification is the A8.6 verification, which sits on the plan the A8.5 owner reports as approved;
- every record belongs to this intake, organization and Claim;
- every owner history is numbered 1..N.

Any absent, ambiguous or foreign record gives 409 `INTEGRITY_CONFLICT`, never a partial reconstruction. The
reconstruction is a derived DTO, never persisted. It proves lineage, not the correctness of a clinical, payer or monetary
outcome.

## Record

**Table:** `exception_closure_events`.

**Columns:**
- `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`, `sequence`, `event_code`;
- `resolution_decision_event_id`, `basis_reference_kind`, `basis_reference_id`, `basis_owner_contract_version`,
  `closure_reason_code`;
- `recorded_by_membership_id`, `recorded_by_user_id`, `recorded_at`, `created_at`.

**Keys and checks:**
- Every foreign key is ON DELETE RESTRICT: intake, organization, Claim, the A8.7 decision event, membership and user.
- The `ESCALATION_RETURN` basis is held by the insert guard against the A8.8 table. A `RESOLUTION_DECISION` basis is the
  decision itself.
- UNIQUE (`exception_intake_id`, `sequence`), and UNIQUE (`exception_intake_id`) for one closure per intake in v1.
- CHECKs pin the contract, a positive sequence, the one event, and each basis kind with its own reason and owner
  contract.

**The insert guard holds:**
- database time; the parent's organization and Claim; the acting membership and its confirm permission;
- the assignment;
- no earlier closure, and the number 1;
- the confirmed A8.7 decision and its request, and the confirmer's independence of both;
- the A8.8 position and the exact basis.

The table is append-only (UPDATE, including a no-op, and DELETE refused) and cannot be truncated, including
TRUNCATE ... CASCADE. No A1–A8.8 or CRG table is altered.

## Transaction

One SERIALIZABLE transaction per closure:
1. The Claim row is locked first, NOWAIT. A busy Claim is waited for outside the transaction within 30 s.
2. The A8.1 intake is re-read and the confirmer is judged.
3. The A8.2 assignment and the A8.3, A8.5, A8.6, A8.7 and A8.8 owners are read on the same client.
4. The closure history is derived.
5. The named decision and basis are resolved, the gate is judged, and independence is checked.
6. Exactly one event and one audit are written.

**On failure:**
- A serialization failure, deadlock or unique collision is retried at most three times, each on a fresh transaction
  that re-reads every owner.
- An unknown commit outcome is reconciled against the committed history and answered 409 with what that history holds.
  It is never retried blindly and never reported as success. There is no idempotency key.

Reads run in one READ ONLY snapshot. The reducer and reconstruction are pure and give the same bytes under any time zone
or locale.

## Implementation decisions (head developer, 2026-11-12)

- **CL-01.** `RESOLVED_INTERNAL` + `RETURNED_TO_OWNER` is eligible with `TERMINAL_FOLLOWUP_REVIEWED`, but only when
  the return reason is `FOLLOWUP_RECORDED`.
  - A return for `FURTHER_WORK_REQUIRED` refuses the closure in v1.
  - The closure names the exact A8.7 decision and the exact A8.8 return event.
  - The reducer, the service and the database insert guard each hold this rule. (Architecture owner, 2026-11-13.)
- **CL-02.** An escalation that is `AWAITING_ACKNOWLEDGEMENT` or `FOLLOWUP_ACTIVE` refuses the closure, even when
  A8.7 is `RESOLVED_INTERNAL`.
  - This is a documented blocked v1 condition.
  - Any future recovery path needs a separately approved, versioned policy. (Architecture owner, 2026-11-13.)
- **D1.** The confirmer holds `exceptionClosure.confirm`.
  - The confirmer is independent of the A8.7 requester and decider, by both user and membership.
  - No further independence from the A8.8 participants or the current assignee is required. (Architecture owner,
    2026-11-13.)
- **D2.** Seven upstream reads on every route.
- **D3.** The intake must be assigned now.
- **D4.** A repeat closure is 409, never a replayed 201.
- **D5.** A RESTRICT key to the A8.7 decision, and a guarded typed basis.
- **D6.** The reconstruction as above.
- **D7.** Error codes as above.
- **D8.** Literals as specified.
- **D9.** Time zone and locale independence, with Arabic UTF-8 synthetic text never reaching a closure DTO or audit.
- **Harness.** `test:a8:exception-closure`, T001–T130, nesting `test:a8:exception-escalation` (A8.8 → A1). T128 keeps
  every original nested FAIL line, verbatim, in `a89-nested-evidence-<runId>.log`, each with its category: BRANCH, HEAD,
  SCOPE or AGGREGATE.

## A7.5 T095 later-phase recognition (included in this PR)

The first full A8.9 clone proof found one regression that is not a defect of A8.9. The accepted A7.5 suite's T095
("Incomplete case is not closure") scans every table name in the database for `closure`, `closed`, `reconcil…` or
`write_off`. It therefore read A8.9's specified table `exception_closure_events`, the internal exception-process
closure record, as a revenue-case closure. That one FAIL reached every suite above A7.5 in the nested chain.

The table keeps its specified name: renaming it to avoid an old check is not allowed. Following the A8.8 precedent (the
A6.10 T087 correction), the correction is made in this PR rather than in a separate corrective PR:

- A7.5's T095 now skips tables created by migrations committed after A7.5's own merge. This is the later-phase rule
  A7.5 already applies in T094 and in its later-domain table check (the same `laterPhaseTables` set, unchanged).
- Every table that existed when A7.5 merged is judged exactly as before. On A7.5's own branch the later-phase set is
  empty, so the predicate is the original one. T095's other two conditions (the `INCOMPLETE_SOURCE_CHAIN` assessment and
  no closure code in A7.5's own migration) are unchanged.
- No A7.5 check id, title or other predicate changed.

A8.9's own T010 proves that this is the only change to an earlier suite: one code line removed and one added, and every
A7.5 check id and title unchanged.

## Out of scope (handoff)

The following stay out of A8.9 and belong to later, separately approved packages:
- reopening a closure, a second closure, or closing a CL-02 or `RETURNED_FOR_REWORK` intake (a future versioned
  policy);
- the A8.10 phase acceptance;
- queues, SLAs, bulk or automatic closure and exports;
- any Claim, A2–A7 or CRG write;
- ICD-10-CM, CPT, HCPCS Level II, DRG, release-right or service-date coding;
- payer and payment facts, remittance and any transmission;
- any CRG activation, Checkpoint C, real DHA activation, and A9.

Production use additionally needs the A10 release gates.
