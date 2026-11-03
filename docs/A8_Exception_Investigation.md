# A8.3 Exception Investigation — Contract Register (A8-EXCEPTION-INVESTIGATION-1)

A8.3 (contract `A8-EXCEPTION-INVESTIGATION-1`) records the evidence-backed work of an investigation of one A8.1
exception intake. Linking one exact, immutable owner record and recording a controlled finding about linked evidence
are each one append-only event in a server-numbered sequence. The investigation view is never stored: it is derived
from the exact sequence on every read. An event never assigns, resolves, closes or escalates an exception, never
asserts a payer, denial, payment or financial outcome, and changes nothing in the intake, its triage history, the Claim
or any source record.

## Start gate

- A8.2 FINAL PASS merged as PR #100, merge `b7ccdc5d18f9029d0b6dc2f09521c549e2744abd` (parents `1e98d48` and the
  accepted A8.2 head `352f748`). Earlier: A8.1 PR #98 `6033d41`, A8.1 harness correction PR #99 `1e98d48`, A7.10
  `0a74f47`.
- Accepted A8.2 interface used here, unchanged:
  - contract `A8-EXCEPTION-TRIAGE-1`;
  - events `TRIAGE_CLASSIFY`, `ASSIGN_OWNER`, `REASSIGN_OWNER`, `RETURN_TO_TRIAGE`;
  - readers on the caller's transaction, `getTriageDispositionOf` and `getTriageHistoryOf(claimId, exceptionIntakeId,
    tx)`;
  - the disposition's `assignedMemberId` (an A1 `organization_memberships` id) and `assigneeCurrentlyEligible` (A1
    effective permissions grant `exceptionTriage.record`);
  - the Claim row lock taken first by every A8 write.
- Name, contract, vocabulary and the decisions below: head developer decisions D14–D22 (2026-11-02). The auditor's
  confirmation under §1 is recorded here when received.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/investigation-events` | `exceptionIntake.read` + `exceptionTriage.read` + `exceptionInvestigation.record` (Admin), and the actor must be the current, eligible A8.2 assignee | 201 with the recorded event |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/investigation-history` | `exceptionIntake.read` + `exceptionTriage.read` + `exceptionInvestigation.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/investigation-summary` | `exceptionIntake.read` + `exceptionTriage.read` + `exceptionInvestigation.read` (Admin, Viewer) | 200, the derived summary |

No session is 401 and a missing permission 403. A Claim, intake or evidence record of another organization or Claim is
the same 404 as a missing one. A malformed id or body is 400. An actor who is not the current, eligible assignee is 409
`EXCEPTION_INVESTIGATION_NOT_ASSIGNEE`, an event that is not a legal next step is 409
`EXCEPTION_INVESTIGATION_TRANSITION_REFUSED`, and a conflicting or uncertain write or an inconsistent stored history is
409 `EXCEPTION_INVESTIGATION_CONFLICT`. The GETs accept no query or body. There is no PUT, PATCH or DELETE, no collection
or cross-Claim search, and no assignment, resolution, closure, escalation or export route. Audit
`exception_investigation.recorded` (entity `EXCEPTION_INVESTIGATION_EVENT`), metadata only, exactly once per recorded
event, in the same transaction.

## Who may write (D21)

Only the member to whom the exception is presently assigned in A8.2 writes, and only while:

- the A8.2 disposition is `ASSIGNED` to exactly the acting user's membership of the organization;
- that assignment is still eligible under the accepted A8.2 policy (`assigneeCurrentlyEligible`);
- the membership holds `exceptionInvestigation.record`.

No Admin override exists in v1. A return to triage, a reassignment to another member or a lost role blocks new writes
until a valid A8.2 reassignment. A historical event is never rewritten when a membership or role later changes.

## Events (v1)

The request is exactly one event code and its own controlled fields; anything else is a 400. The server derives the
actor and membership, the organization, the Claim, the basis code, the sequence and the time.

| eventCode | Request fields | Rule |
|---|---|---|
| `LINK_EVIDENCE_REFERENCE` | `evidenceKind`, `evidenceRecordId`, `evidenceContractVersion` | The record exists for this exact intake, Claim and organization through its own owner; the same record is linked once per kind |
| `RECORD_FINDING` | `linkedEvidenceEventId`, `findingCode` | Names an earlier link event of this intake; never repeats the latest finding unchanged |

Evidence kinds (D15–D17) — a link stores a pointer only, never a copy of the record, a digest or any payload:

| evidenceKind | evidenceRecordId | evidenceContractVersion | Verified through |
|---|---|---|---|
| `INTAKE_BASIS` | the parent intake's stored `basisRecordId`; the intake's `basisCode` is stored with the link and verified by the database | `A8-EXCEPTION-INTAKE-1` | A8.1 `getExceptionIntakesOf` |
| `TRIAGE_EVENT` | an A8.2 triage event of the same intake | `A8-EXCEPTION-TRIAGE-1` | A8.2 `getTriageHistoryOf` |
| `A7_CASE_ASSESSMENT` | an A7.5 closure-prerequisite assessment of a case of the same Claim and organization | `A7-CLOSURE-PREREQ-1` | A7.5 `findAssessmentById` + `findCaseForPrerequisite` (the path A8.1 accepted) |

Each kind is accepted under exactly its one contract; any other contract, kind or field is a 400. Finding codes, which
are observations about linked evidence and never proof of loss, denial, overpayment, liability, a financial shortfall
or a resolution:

- `EVIDENCE_CONFIRMS_RECORDED_CONFLICT`
- `EVIDENCE_INCONCLUSIVE`
- `FURTHER_REVIEW_REQUIRED`

A change of vocabulary is a versioned A8-owned contract change. Nothing is linked automatically: ordinary A7 evidence
absence never starts an investigation.

## Record

Table `exception_investigation_events` has these columns:

- `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`, `sequence`, `event_code`;
- `evidence_kind`, `evidence_record_id`, `evidence_contract_version`, `evidence_basis_code`;
- `linked_evidence_event_id`, `finding_code`;
- `recorded_by_membership_id`, `recorded_by_user_id`, `recorded_at`, `created_at`.

Every foreign key is ON DELETE RESTRICT. `(exception_intake_id, sequence)` and
`(exception_intake_id, evidence_kind, evidence_record_id)` are unique.

- CHECKs pin the contract, a positive sequence, the two event codes and each event's exact shape, including each
  evidence kind's one contract and the basis code only on an intake-basis link.
- The insert guard holds:
  - the database's own time;
  - the parent intake's organization and Claim;
  - the acting user's own membership of that organization;
  - the latest A8.2 triage event assigning the exception to exactly that membership, whose roles grant both
    `exceptionTriage.record` and `exceptionInvestigation.record` at that moment;
  - the next contiguous number;
  - the referenced record of its kind for this intake, Claim and organization;
  - a finding's earlier link of this intake;
  - no unchanged repeat of the latest finding.
- Triggers refuse every UPDATE (a no-op included), DELETE and TRUNCATE.

There is no status, current or latest, resolution, remediation, SLA, escalation, amount, currency, payer, narrative,
attachment, payload, digest, queue or export column.

## Summary

`GET …/investigation-summary` answers:

- `contractVersion`, `exceptionIntakeId`;
- `investigationCode` (`NOT_STARTED`, `EVIDENCE_LINKED` or `FINDING_RECORDED`);
- `evidenceLinks`, `findings`, `latestFinding` (the finding with the highest sequence, or null);
- `eventCount`, `lastSequence`, `evaluatedAt`.

A pure reducer replays the stored events in sequence. Any of the following refuses the read (409); it is never repaired
or guessed from a time or an id:

- a gap, or a reused or wrong first number;
- an unknown contract or code, or a wrong shape;
- another intake's or tenant's row;
- a finding before or without its link;
- a duplicate link or an unchanged repeated finding.

`NOT_STARTED` is zero rows. There is no `RESOLVED` or `INVESTIGATION_COMPLETE`. The A8.1 intake and the A8.2
disposition remain their own sources of truth and are not copied into the summary.

## Writes, concurrency and uncertain outcomes

A write runs in one SERIALIZABLE transaction in this order:

1. The Claim row lock is the first statement, taken without waiting. An A8.2 reassignment or return on the same Claim is
   therefore serialized with it.
2. The parent intake is found through A8.1 `getExceptionIntakesOf` on the same transaction.
3. The A8.2 disposition is re-read through `getTriageDispositionOf`, and the actor is judged as above before anything
   else.
4. The stored investigation history is derived.
5. A link's record is verified through its owner, and the next step judged.
6. Exactly one event and one audit are appended.

**Retries.** A busy Claim is waited for, within a time budget, outside the transaction. A serialization failure,
deadlock or unique-key collision is retried on a fresh transaction that re-reads and re-judges everything (at most
three attempts). There is no idempotency key, so an exact repeat after a commit is a deterministic 409, and two
identical concurrent writes record one event and one audit.

**Uncertain outcome.** If the connection is lost while committing, the outcome is reconciled on a fresh read of the
committed history at the attempted sequence (the pure `reconcileAttempt`, as accepted for A8.2). The answer is always
409, stating one of:

- exactly this event (same membership, actor and every controlled field) is committed, with its id;
- another event holds that number;
- no event holds it;
- the history could not be read.

The request is never sent again and success is never reported.

## Integration points

- `getInvestigationHistoryOf(claimId, exceptionIntakeId, tx)` and `getInvestigationSummaryOf(claimId, exceptionIntakeId,
  tx)` read on the caller's transaction.
- `recordInvestigationEventOn(claimId, exceptionIntakeId, body, actorUserId, tx)` records on the caller's transaction.
