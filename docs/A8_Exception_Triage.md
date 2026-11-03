# A8.2 Exception Triage — Contract Register (A8-EXCEPTION-TRIAGE-1)

A8.2 records the internal triage and assignment history of one A8.1 exception intake. The intake, a classification,
the accountable member it is assigned to, a reassignment and a return to triage are each one append-only event in a
server-numbered sequence. The current disposition is never stored: it is derived from the exact sequence on every
read. An event is never an investigation, resolution, closure, SLA, escalation, payer outcome, payment or export, and
it changes nothing in the intake, the Claim or any source record.

## Architecture approval

**CONDITIONAL ARCHITECTURE APPROVAL — 2026-11-01** (auditor). The scope, the three routes, the append-only event
model, the derived disposition, the permissions, the return-reason vocabulary, the atomic audit and the T001–T130
acceptance structure are approved under these conditions, each met by this package:

1. **Assignee eligibility.** An assignee is an existing A1 organization membership of the intake's organization whose
   roles currently grant `exceptionTriage.record` (Admin in v1). No new active-member field is introduced. A
   historical assignment is never rewritten when a membership or role later changes; the disposition reports the
   historical assignee (`assignedMemberId`) separately from that member's current eligibility
   (`assigneeCurrentlyEligible`).
2. **Reclassification.** `TRIAGE_CLASSIFY` is accepted from `UNTRIAGED`, and from `TRIAGED` only when the category or
   the priority changes. An `ASSIGNED` exception must first `RETURN_TO_TRIAGE`; it is never reclassified directly.
3. **Duplicates and uncertain outcomes.** There is no idempotency key in v1. An illegal or duplicate transition is a
   409 and writes nothing. An uncertain commit is reconciled against the exact committed history; it is never
   retried blindly and success is never inferred.
4. **Database integrity.** The database itself enforces the contiguous sequence, the legal transition, the tenant
   and intake identity, the assignee's eligibility at insertion and append-only history; the event and its audit are
   created atomically. Direct-SQL and concurrent-transition negative tests prove it, and historical events are never
   rewritten when roles change.
5. **Boundaries.** No investigation, resolution, escalation, SLA enforcement, payer status, financial outcome,
   automatic work queue or audit export. A8.1 records and every A6/A7 owner are unchanged.

## Routes and permissions

| Route | Permissions | Answer |
|---|---|---|
| `POST /api/claims/:claimId/exceptions/:exceptionIntakeId/triage-events` | `exceptionIntake.read` + `exceptionTriage.record` (Admin) | 201 with the recorded event |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/triage-history` | `exceptionIntake.read` + `exceptionTriage.read` (Admin, Viewer) | 200, events in sequence order |
| `GET /api/claims/:claimId/exceptions/:exceptionIntakeId/triage-disposition` | `exceptionIntake.read` + `exceptionTriage.read` (Admin, Viewer) | 200, the derived disposition |

No session is 401 and a missing permission 403. A Claim or intake of another organization is the same 404 as a
missing one. A malformed id or body is 400, and an illegal transition, an ineligible assignee or a conflicting or
uncertain write is 409. The GETs accept no query or body: there is no client-selected current or latest. There is
no PUT, PATCH or DELETE, no collection or cross-Claim search, and no investigation, resolution, escalation or export
route. Audit `exception_triage.recorded` (entity `EXCEPTION_TRIAGE_EVENT`), metadata only, exactly once per
recorded event, in the same transaction.

## Events (v1)

The request is exactly one event code and its own controlled fields; anything else is a 400. The server derives
the actor, the organization, the Claim, the sequence and the time.

| eventCode | Request fields | Accepted from | Disposition after |
|---|---|---|---|
| `TRIAGE_CLASSIFY` | `categoryCode`, `priorityCode` | `UNTRIAGED`; `TRIAGED` only when the category or priority changes | `TRIAGED`, no assignee |
| `ASSIGN_OWNER` | `assignedMemberId` | `TRIAGED` | `ASSIGNED` to that member |
| `REASSIGN_OWNER` | `assignedMemberId` (another member) | `ASSIGNED` | `ASSIGNED`; the prior holder stays in the history |
| `RETURN_TO_TRIAGE` | `reasonCode` | `ASSIGNED` | `TRIAGED`, no assignee |

Any other pair is a 409 and records nothing. Controlled codes:

- Categories: `PROVENANCE_INTEGRITY`, `SOURCE_REFERENCE`, `CONTRACT_COMPATIBILITY`, `HISTORICAL_COHERENCE`,
  `HUMAN_REVIEW`.
- Priorities, for internal review order only (never clinical urgency, payer status or financial exposure): `ROUTINE`,
  `ELEVATED`, `URGENT`.
- Return reasons: `ASSIGNEE_UNAVAILABLE`, `ASSIGNMENT_INCORRECT`, `CLASSIFICATION_REVIEW_NEEDED`.

A change of vocabulary is a versioned A8-owned contract change.

## Record

Table `exception_triage_events`: `id`, `exception_intake_id`, `organization_id`, `claim_id`, `contract_version`,
`sequence`, `event_code`, `category_code`, `priority_code`, `assigned_member_id` (an A1 membership), `reason_code`,
`recorded_by_user_id`, `recorded_at`, `created_at`. Every foreign key is ON DELETE RESTRICT; `(exception_intake_id,
sequence)` is unique.

- CHECKs pin the contract, a positive sequence, the four event codes and each event's exact shape.
- The insert guard holds the database's own time, the parent intake's organization and Claim, an acting member of
  that organization, the next contiguous number, the legal transition from the derived disposition, and an assignee
  whose roles grant `exceptionTriage.record` at that moment.
- Triggers refuse every UPDATE (a no-op included), DELETE and TRUNCATE.

There is no status, current or latest, SLA, escalation, investigation, resolution, amount, payer, narrative,
attachment, payload, queue or export column.

## Disposition

`GET …/triage-disposition` answers `contractVersion`, `exceptionIntakeId`, `dispositionCode` (`UNTRIAGED`,
`TRIAGED` or `ASSIGNED`), `categoryCode`, `priorityCode`, `assignedMemberId`, `assigneeCurrentlyEligible`,
`eventCount`, `lastSequence` and `evaluatedAt`.

- **How it is derived.** A pure reducer replays the stored events in sequence. A gap, a reused or wrong first
  number, an unknown contract or code, a wrong shape, another intake's or tenant's row, or an impossible transition
  refuses the read (409). It is never repaired or guessed from a time or an id. `UNTRIAGED` is zero rows.
- **`assigneeCurrentlyEligible`.** `null` when nothing is assigned. Otherwise it is evaluated on every read with A1's
  effective permissions: `false` once the member lost the permission or the membership. The historical
  `assignedMemberId` is unchanged.

## Writes, concurrency and uncertain outcomes

A write runs in one SERIALIZABLE transaction in this order:

1. The Claim row lock is the first statement, taken without waiting.
2. The parent intake is found through A8.1 `getExceptionIntakesOf` on the same transaction.
3. The history is derived and the transition judged.
4. The assignee's eligibility is checked through A1 `getEffectivePermissions`.
5. Exactly one event and one audit are appended.

**Retries.** A busy Claim is waited for, within a time budget, outside the transaction. A serialization failure,
deadlock or unique-key collision is retried on a fresh transaction that re-reads and re-judges everything (at most
three attempts). There is no idempotency key, so an exact repeat after a commit is a deterministic 409.

**Uncertain outcome.** If the connection is lost while committing, the outcome is unknown. It is then reconciled on
a fresh read of the committed history at the attempted sequence, and the answer is always 409 stating one of:

- exactly this event (same actor and every controlled field) is committed, with its id;
- another event holds that number, so nothing of this request was recorded;
- no event holds it, so nothing was recorded;
- the history could not be read, so the caller must read it.

The request is never sent again and success is never reported.

## Observations

- The audit's `afterState.recordedAt` is the event's own database time, to the millisecond. The audit row's
  `occurred_at` is filled by the accepted A1 audit writer through Prisma's `@default(now())`, that is, the
  application clock at the moment of the write inside the same transaction. It is therefore a few milliseconds after
  the event's database time. A8.2 does not change the A1 writer; aligning A1 audit time with database time is an A10
  backlog item.

## Integration points

- `getTriageHistoryOf(claimId, exceptionIntakeId, tx)` and `getTriageDispositionOf(claimId, exceptionIntakeId, tx)`
  read on the caller's transaction.
- `recordTriageEventOn(claimId, exceptionIntakeId, body, actorUserId, tx)` records on the caller's transaction.
