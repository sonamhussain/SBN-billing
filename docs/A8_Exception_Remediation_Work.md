# A8.6 Exception Remediation Work — Contract Register (A8-REMEDIATION-WORK-1)

A8.6 (contract `A8-REMEDIATION-WORK-1`) records what an authorized member reports completing against one A8.5
`APPROVED_FOR_PLANNING` proposal, and whether a different authorized member can verify that report from an identified,
existing A8.3 record. Each report and each verification is one append-only event in a server-numbered sequence. The
work disposition is never stored: it is derived from the exact sequence on every read.

A report is an **attestation**, and a verification confirms **only** that the cited internal record and the report
agree. A8.6 never does any of the following:

- execute the approved A8.5 action, or correct, resolve, close or escalate anything;
- assert a payer, patient, clinical, payment or financial outcome, or declare an exception RESOLVED or CLOSED;
- change the intake, its triage, investigation or remediation history, the Claim, any A2–A7 or CRG record, or any
  source record.

## Start gate

- **Predecessor.** A8.5 was merged as PR #104 at `0f8f9d3bc18347b1360b72b93056724b594a6e00`. CRG-01 Checkpoint B was
  merged as PR #105 at `4869df3c81ac4af5dcec988768666f7acd3d809e`.
- **Branch.** `feature/a8-6-remediation-work-verification` is cut from clean, synchronized main
  `4869df3c81ac4af5dcec988768666f7acd3d809e` (the Checkpoint B merge), which contains both merges. It is not stacked on a feature
  branch.
- **A8.4 stays closed.** On 2026-11-04 the architecture owner closed the earlier A8.4 specification as a duplicate of
  A8.3. No A8.4 code exists.
- **CRG-01 is independent.** A8.6 writes no CRG record, enables no real DHA/DOH scope and imports nothing.
  `CODING_REFERENCE_REVIEW_REPORTED` reports an internal review only and implies no DHA compliance.
- **Scope approval.** The architecture owner approved the A8.6 scope (`A8.6_Scope_Approval_Request_v1.0`, decisions
  D1–D13) on 2026-11-07.
- **Accepted interfaces used here, unchanged:**
  - A8.1 `getExceptionIntakesOf(claimId, tx)`;
  - A8.2 `getTriageDispositionOf(claimId, exceptionIntakeId, tx)`, with `dispositionCode`, `assignedMemberId` and
    `assigneeCurrentlyEligible`;
  - A8.3 `getInvestigationHistoryOf(claimId, exceptionIntakeId, tx)` and its `LINK_EVIDENCE_REFERENCE` and
    `RECORD_FINDING` events;
  - A8.5 `getRemediationDispositionOf(claimId, exceptionIntakeId, tx)` (its `approvedProposalEventId`) and
    `getRemediationHistoryOf(claimId, exceptionIntakeId, tx)` (the approved `PROPOSE_ACTION` and its `APPROVE_PROPOSAL`
    review);
  - the A6.7 Claim ownership path;
  - the Claim row lock taken first by every A8 write.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/remediation-work-events` | `exceptionIntake.read` + `exceptionTriage.read` + `exceptionInvestigation.read` + `exceptionRemediation.read`, plus the event's own permission: `exceptionRemediationWork.record` for a report or `exceptionRemediationWork.verify` for a verification (Admin) | 201 with the recorded event |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/remediation-work-history` | the four read permissions + `exceptionRemediationWork.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/remediation-work-disposition` | the four read permissions + `exceptionRemediationWork.read` (Admin, Viewer) | 200, the derived disposition |

**Error answers:**

| Situation | Answer |
|---|---|
| No session | 401 |
| A missing permission | 403 |
| A Claim, intake, proposal or evidence record of another organization, Claim or intake | 404, the same as a missing one |
| A malformed id or body, or an unknown field or code | 400 `VALIDATION_ERROR` |
| An evidence kind outside v1 | 400 `UNSUPPORTED_EVIDENCE_KIND` |
| A reporter who is not the current, eligible assignee holding the record permission | 409 `EXCEPTION_REMEDIATION_WORK_NOT_ASSIGNEE` |
| A verifier without the verify permission now, or the report's own reporter | 409 `EXCEPTION_REMEDIATION_WORK_REVIEWER_NOT_INDEPENDENT` |
| An event that is not a legal next step | 409 `EXCEPTION_REMEDIATION_WORK_TRANSITION_REFUSED` |
| A conflicting or uncertain write, or an inconsistent stored or owner history | 409 `EXCEPTION_REMEDIATION_WORK_CONFLICT` |

- The GETs accept no query or body.
- There is no PUT, PATCH or DELETE, no collection, queue, current or sequence selector, and no execution, correction,
  resolution, closure, escalation or export route.
- Audit `exception_remediation_work.recorded` (entity `EXCEPTION_REMEDIATION_WORK_EVENT`) is written exactly once per
  recorded event, in the same transaction, metadata only.
- The reader for a future owner is `getWorkDispositionOf(claimId, exceptionIntakeId, tx)`. It reads on the caller's
  transaction and opens none of its own.

## Who may write

**Reporter (D6).** The member to whom the exception is presently assigned in A8.2, and only while:

- the A8.2 disposition is `ASSIGNED` to exactly the acting user's membership of the organization;
- that assignment is still eligible under the accepted A8.2 policy (`assigneeCurrentlyEligible`);
- the membership holds `exceptionRemediationWork.record` now;
- the intake's A8.5 disposition is `APPROVED_FOR_PLANNING`.

**Verifier (D7).** A member of the same organization, and only while:

- the membership holds `exceptionRemediationWork.verify` now (checked at verification time);
- the membership and the user both differ from the report's, so a user acting through another membership is refused;
- the exception is still `ASSIGNED`;
- the verification names exactly the report that awaits verification.

The A8.5 approver may verify. Independence is judged against the reporter only.

## Events (v1)

The request is exactly one event code and its own controlled fields; anything else is a 400. The server derives the
actor and membership, the organization, the Claim, the sequence, the time, the evidence contract and, for a
verification, the approved proposal.

| eventCode | Request fields | Rule |
|---|---|---|
| `RECORD_WORK_REPORT` | `approvedProposalEventId`, `workCode`, `basisReferenceKind`, `basisReferenceId` | The proposal is exactly the intake's approved A8.5 proposal. The work code is the one that answers its action (D2). The record is an A8.3 event of exactly this intake, Claim and organization whose event code is its kind's (D3, D4). |
| `VERIFY_WORK_REPORT` | `workReportEventId`, `verificationCode`, and `reasonCode` exactly when the code is `EVIDENCE_NOT_VERIFIED` | The report is exactly the one that awaits verification. |

**Controlled values:**
- `workCode`, 1:1 with the approved A8.5 `actionCode` (no second action vocabulary):

  | A8.5 actionCode | workCode |
  |---|---|
  | `REVIEW_SOURCE_PROVENANCE` | `SOURCE_PROVENANCE_REVIEWED` |
  | `REQUEST_INTERNAL_DOCUMENTATION_CHECK` | `DOCUMENTATION_CHECK_REPORTED` |
  | `RECHECK_CODING_REFERENCE` | `CODING_REFERENCE_REVIEW_REPORTED` |
  | `REFER_FOR_POLICY_REVIEW` | `POLICY_REVIEW_REFERRED` |

- `basisReferenceKind`, both allowed for all four work codes in v1:

  | basisReferenceKind | A8.3 event code |
  |---|---|
  | `INVESTIGATION_EVIDENCE_LINK` | `LINK_EVIDENCE_REFERENCE` |
  | `INVESTIGATION_FINDING` | `RECORD_FINDING` |

  `basis_reference_contract_version` is always `A8-EXCEPTION-INVESTIGATION-1`. There is no attachment system.
- `verificationCode`: `EVIDENCE_SUPPORTED`, `EVIDENCE_NOT_VERIFIED`.
- `reasonCode` (`EVIDENCE_NOT_VERIFIED` only): `SOURCE_MISSING`, `SOURCE_MISMATCH`, `INSUFFICIENT_SUPPORT`.

## Derived disposition (D8)

| State | Meaning |
|---|---|
| `NO_WORK_REPORT` | No event (zero rows; nothing stored). Never inferred complete from the A8.5 approval alone. |
| `AWAITING_VERIFICATION` | The latest event is the report; `report` names it |
| `VERIFIED_INTERNAL_WORK` | The report was verified as `EVIDENCE_SUPPORTED`. Terminal for the v1 approved proposal. |
| `NOT_VERIFIED` | The report was `EVIDENCE_NOT_VERIFIED`. Terminal for the v1 report; follow-on work needs a separately approved policy. |

**Refused transitions (409, no event, no audit):**
- a report without an approved proposal, against another proposal, or with a work code that is not its action's;
- a second report while one awaits verification, or any report after a verification (one report per approved proposal);
- a verification when nothing is outstanding, or of another report;
- a verification by the report's own membership or user;
- any event after a verification.

The disposition answers:
- `state`, `approvedProposalEventId`, `report` and `verification`;
- `eventCount` and `lastSequence`;
- `evaluatedAt`, the database read time.

A historical verification is never recomputed from present permissions or present source status.

## Record (D11)

**Table:** `exception_remediation_work_events`.

**Columns:**
- `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`, `sequence`, `event_code`;
- `approved_proposal_event_id` (on both events, D5);
- `work_code`, `basis_reference_kind`, `basis_reference_id`, `basis_reference_contract_version`;
- `work_report_event_id`, `verification_code`, `reason_code`;
- `recorded_by_membership_id`, `recorded_by_user_id`, `recorded_at`, `created_at`.

**Keys and checks:**
- Every foreign key is ON DELETE RESTRICT: intake, organization, Claim, the approved A8.5 proposal event, the A8.3
  evidence event, the report event (self), membership and user.
- UNIQUE (`exception_intake_id`, `sequence`) and UNIQUE (`work_report_event_id`), so there is at most one verification
  per report.
- CHECKs pin the contract, a positive sequence, the two events and each event's exact shape and vocabulary.

**The insert guard holds:**
- database time;
- the parent's organization and Claim;
- the acting membership;
- the intake being currently assigned by its latest A8.2 event;
- the approved A8.5 proposal of this intake (a `PROPOSE_ACTION` with an `APPROVE_PROPOSAL` review), the same on every
  event of the intake;
- for a report: the assignee, both role permissions, the 1:1 work code and an A8.3 event of this intake of the cited
  kind;
- for a verification: the verify permission and independence from the reporter;
- the outstanding report, a verification being terminal and a contiguous sequence.

The table is append-only (UPDATE, including a no-op, and DELETE refused) and cannot be truncated, including
TRUNCATE ... CASCADE. No A1–A8.5 or CRG table is altered.

## Transaction (D10)

One SERIALIZABLE transaction per event:
1. The Claim row is locked first, NOWAIT. A busy Claim is waited for outside the transaction within 30 s.
2. The A8.1 intake, the A8.2 disposition, the A8.3 history and the A8.5 disposition and history are re-read through
   their owners.
3. The actor is judged.
4. The history is derived by the pure reducer against the approved proposal.
5. The proposal and the evidence are verified.
6. Exactly one event and one audit are written.

**On failure:**
- A serialization failure, deadlock or unique collision is retried at most three times, each on a fresh transaction
  that re-reads everything.
- An unknown commit outcome is reconciled against the committed history and answered 409 with what that history holds.
  It is never retried blindly and never reported as success. There is no idempotency key.

Reads run in one READ ONLY snapshot; a corrupt or unsupported history is 409, never a partial view.

## Approved decisions (D1–D13, 2026-11-07)

- **D1. Names.** As specified: contract `A8-REMEDIATION-WORK-1`, table `exception_remediation_work_events`, module
  `exception-remediation-work`, permissions `exceptionRemediationWork.record` / `.verify` (Admin) and `.read` (Admin,
  Viewer), audit `exception_remediation_work.recorded`, exactly the three routes above.
- **D2. Work code.** 1:1 with the approved A8.5 action, in the pure reducer and the database guard.
- **D3. Evidence kinds.** `INVESTIGATION_EVIDENCE_LINK` and `INVESTIGATION_FINDING`, both for all four work codes in v1.
  Narrowing per work code would be a new version.
- **D4. Evidence integrity.** One RESTRICT foreign key to `exception_investigation_events` plus the guard (same intake,
  Claim and organization; event code matches the kind), so the column is never a generic UUID.
- **D5. Plan reference.** `approved_proposal_event_id` on both events, RESTRICT, checked against the approved proposal.
- **D6. Reporter** and **D7. Verifier** as above.
- **D8. States** derived, never stored; one report per approved proposal.
- **D9. Error codes** as above.
- **D10. Transactions** as above.
- **D11. Schema.** One additive migration, no stored status, current or latest.
- **D12. Frontend.** One strictly read-only Developer Tools check page.
- **D13. Harness.** `test:a8:remediation-work`, T001–T130, nesting `test:a8:exception-remediation` (A8.5 → A1). The
  expected A8.5 branch-only N/A list is T001, T003, T010, T110, T127 and T129, each with a cause proof; for T110 every
  nested A8.3 item is re-proved on this branch down to A7.9.

  Two checks are carried over from the Checkpoint B review (PR #105), with no new check id:
  - T110 also keeps every original nested FAIL line, verbatim, in `a86-nested-evidence-<runId>.log` (SHA-256 in
    T128), each with its category: BRANCH, HEAD, SCOPE or AGGREGATE. A line of any other kind fails T110.
  - T119 also requires zero pg `client.query()` concurrent-query deprecation warnings in this process and in every
    process of the nested chain.

## Out of scope (handoff)

The following stay out of A8.6 and belong to later, separately approved packages:
- executing any A8.5 action;
- resolving or closing an exception;
- follow-on work after a `NOT_VERIFIED` report (a separately versioned policy);
- queues, SLAs, escalation and exports;
- any Claim, A2–A7 or CRG write;
- payer and payment facts;
- any CRG activation.

Production use additionally needs the A10 release gates.
