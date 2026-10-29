# A8.1 Exception Intake — Contract Register (A8-EXCEPTION-INTAKE-1)

A8.1 records that one exact source record of an accepted owner carries an operational exception **that its own
owner established**. An intake is immutable and anchors an exception identity for later A8 owners. It is never a
payer verdict, denial, payment, balance, closure, assignment, status or resolution, and it changes nothing in the
record it names. Absence of external financial evidence is never an exception.

Architecture-owner approval: PENDING — replace this line with "Architecture-owner approval: approved on YYYY-MM-DD"
once the auditor has approved the A8.1 scope, before the two official runs (T120 reads it).

## Request and record

`POST /api/claims/:claimId/exception-intake` (permission `exceptionIntake.create`, Admin) accepts exactly
`sourceKind`, `sourceRecordId`, `sourceContractVersion` and `exceptionReasonCode`. Any other field (an id, identity
key, organization, actor, time, status, `contextCode`, amount, payload, description or resolution) is a 400. A new
intake is 201; the exact repeated request is 200 with the identical stored DTO, no new row and no audit.
`GET /api/claims/:claimId/exception-intake` (`exceptionIntake.read`, Admin and Viewer) lists the Claim's intakes in
recorded order, then id. There is no `/:id` read, PATCH, PUT or DELETE.

The record holds only identifiers, controlled codes, an owner-supplied digest or null, the acting member and database
time. Physical table `operational_intake_records` (kept clear of the A6.10 and A7.x phase-boundary table scans; the
API, model, module, permissions and audit keep the business name). Audit `exception_intake.recorded`, metadata only,
on the first insert.

## Source kinds (v1)

| sourceKind | sourceRecordId | sourceContractVersion | Owner verdict read on the intake transaction | Fingerprint |
|---|---|---|---|---|
| `REVENUE_TIMELINE` | the Claim's own id | `A7-REVENUE-TIMELINE-1` | A7.7 `getRevenueTimelineOf(claimId, tx)` | null |
| `CLOSURE_PREREQUISITE_ASSESSMENT` | the A7.5 assessment id | `A7-CLOSURE-PREREQ-1` | the stored A7.5 assessment and A7.6 `getClosureBasisTraceOf(assessmentId, tx)` | the assessment's stored case digest |

A source of another Claim or organization, or one that does not exist, is the same 404 as a missing Claim.

## Reasons and the verdict that establishes each

| Reason | Established when | Admissible kinds |
|---|---|---|
| `PROVENANCE_CONFLICT` | the A7.7 owner refuses the Claim's history (409) | `REVENUE_TIMELINE` |
| `HISTORICAL_RECORD_INCONSISTENT` | the A7.6 owner refuses the assessment's trace: the stored assessment disagrees with its stored case (409) | `CLOSURE_PREREQUISITE_ASSESSMENT` |
| `OPERATOR_REVIEW_REQUIRED` | the stored A7.5 outcome is `REVIEW_REQUIRED` | `CLOSURE_PREREQUISITE_ASSESSMENT` |
| `CONTRACT_VERSION_UNSUPPORTED` | no accepted owner reports it distinctly today | none |
| `SOURCE_REFERENCE_UNAVAILABLE` | every A6/A7 reference is a RESTRICT foreign key, so no owner can report it today | none |

A reason the owner does not establish is a 409 `INTAKE_BASIS_NOT_ESTABLISHED` and is never stored. The last two
reasons stay in the controlled vocabulary (and its CHECK) but no (kind, reason) pair admits them; a later versioned
A8 change with a narrow owner export can enable them. A stored `EXTERNAL_FINANCIAL_EVIDENCE_ABSENT` or any other
normal outcome establishes nothing: there is no automatic scan, backfill or inferred exception.

## Identity

`identityKey` is the SHA-256 of one canonical preimage, recomputed by the database insert guard:

```
A8-EXCEPTION-INTAKE-1
organization=<uuid>
claim=<uuid>
sourceKind=<code>
sourceRecord=<uuid>
sourceContract=<code>
reason=<code>
```

Each line ends with a line feed; UUIDs are lowercase canonical and codes uppercase, and no part may contain a line
break or `=`. A different reason on the same source is a separate intake; an existing one is never overwritten.

## Harness corrections carried by A8.1 (disclosed)

A8.1 is the first package since A7.5 to add a migration and permissions, and the first A8 file. Two kinds of
earlier phase-boundary predicates would otherwise fail on every later branch. Only these were changed, harness-only:

- A7.6–A7.10, the "this package changed nothing else" checks (A7.6 T004/T006/T007/T009, A7.7 T004–T007/T009, A7.8 and
  A7.9 T004/T006/T007/T009, A7.10 T004/T007/T008): on the package's own branch they keep judging its diff against
  main; on any later branch they judge exactly what the package's own merge added.
- A7.10 T099/T100: the file checks look at A7-owned paths only (an A8 module or suite is A8's to prove).

No product code of A1–A7, no applied migration and no substantive assertion was changed.
