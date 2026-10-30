# A8.1 Exception Intake — Contract Register (A8-EXCEPTION-INTAKE-1)

A8.1 records that one exact source record of an accepted owner carries an operational exception **whose specific
condition its owners' own stored facts prove**. An intake is immutable and anchors an exception identity for later
A8 owners. It is never a payer verdict, denial, payment, balance, closure, assignment, status or resolution, and it
changes nothing in the record it names. Absence of external financial evidence is never an exception.

## Architecture approval

**CONDITIONAL ARCHITECTURE APPROVAL — 2026-10-29** (auditor). Conditions, each met by this package:

1. API and permissions as proposed: immutable intakes, strict tenant isolation, exactly one atomic metadata-only
   audit on a successful creation.
2. Both source kinds have exact owner identity and source-backed evidence; an ordinary 409 alone never establishes
   an exception (see *Reasons and their basis*).
3. `PROVENANCE_CONFLICT` and `HISTORICAL_RECORD_INCONSISTENT` require proof of their specific underlying condition;
   `OPERATOR_REVIEW_REQUIRED` requires the exact recorded `REVIEW_REQUIRED` assessment; unsupported reasons stay
   disabled; no automatic financial exception.
4. The physical table is `exception_intake_records`. Earlier phase checks recognize it as a later-phase table by
   migration provenance (the separately merged harness correction, `docs/Harness_Corrections.md`), never by a name
   chosen to avoid them.
5. Historical acceptance corrections were made in their own corrective PR, not in A8.1; A8.1 changes no A1–A7 file.
6. No `contextCode` in v1. An exact duplicate replays the original immutable record only after every canonical
   field of the stored row and the tenant are verified. A new intake always requires current owner-backed proof.
7. Each intake retains its controlled basis and the owner record it names, so its original basis can be explained
   later; no digest is fabricated and no PHI or owner error text is stored; an unproven reason fails closed.

No accepted A6/A7 product architecture was modified to accommodate A8.1.

## Request and record

`POST /api/claims/:claimId/exception-intake` (permission `exceptionIntake.create`, Admin) accepts exactly
`sourceKind`, `sourceRecordId`, `sourceContractVersion` and `exceptionReasonCode`. Any other field (an id, identity
key, basis, organization, actor, time, status, `contextCode`, amount, payload, description or resolution) is a 400.
A new intake is 201; the exact repeated request is 200 with the identical stored DTO, no new row and no audit.
`GET /api/claims/:claimId/exception-intake` (`exceptionIntake.read`, Admin and Viewer) lists the Claim's intakes in
recorded order, then id. There is no `/:id` read, PATCH, PUT or DELETE.

The record (table `exception_intake_records`) holds only identifiers, controlled codes, an owner-supplied digest or
null, the controlled basis and the owner record it names, the acting member and database time. Audit
`exception_intake.recorded`, metadata only, on the first insert.

## Source kinds (v1)

| sourceKind | sourceRecordId | sourceContractVersion | Owners read on the intake transaction | Fingerprint |
|---|---|---|---|---|
| `REVENUE_TIMELINE` | the Claim's own id | `A7-REVENUE-TIMELINE-1` | A7.7 `getRevenueTimelineOf`; on a refusal, A6.7 `findFreezesOfClaim`, A6.9 `findFreezeFacts`, `findLinksOfClaim` and `orderCorrectionChain` | null |
| `CLOSURE_PREREQUISITE_ASSESSMENT` | the A7.5 assessment id | `A7-CLOSURE-PREREQ-1` | A7.5 `findAssessmentById` and `findCaseForPrerequisite`, A7.6 `getClosureBasisTraceOf`; on a refusal, A7.4 `findCaseById` | the assessment's stored case digest |

A source of another Claim or organization, or one that does not exist, is the same 404 as a missing Claim.

## Reasons and their basis

An owner's refusal alone is never a basis. A reason is recorded only when its specific condition holds in the owners'
stored facts at the moment of the intake; the controlled `basisCode` and the owner record it names (`basisRecordId`)
are stored with the intake, and the database insert guard re-checks the same fact.

| Reason | basisCode | Specific condition (all must hold) | basisRecordId |
|---|---|---|---|
| `PROVENANCE_CONFLICT` | `UNLINKED_FROZEN_SUBMISSION` | A7.7 refuses the Claim's history; the Claim has two or more A6.7 freezes; the A6.9 links form one valid chain of this Claim's freezes; a freeze lies outside it. Two unlinked freezes at one instant are ambiguous and fail closed | the latest unlinked freeze |
| `HISTORICAL_RECORD_INCONSISTENT` | `ASSESSMENT_CASE_ORGANIZATION_MISMATCH` | A7.6 refuses the trace; the stored assessment's organization is not its stored case's | the assessed case |
| `HISTORICAL_RECORD_INCONSISTENT` | `ASSESSMENT_CASE_DIGEST_MISMATCH` | A7.6 refuses the trace; the organizations agree; the assessment's copied case digest is not the case's stored digest | the assessed case |
| `OPERATOR_REVIEW_REQUIRED` | `ASSESSMENT_REVIEW_REQUIRED` | the stored A7.5 outcome is exactly `REVIEW_REQUIRED` | the assessment |
| `CONTRACT_VERSION_UNSUPPORTED` | — | no accepted owner reports it distinctly today | disabled |
| `SOURCE_REFERENCE_UNAVAILABLE` | — | every A6/A7 reference is a RESTRICT foreign key, so no owner can report it today | disabled |

Every other refusal (a fork, join, cycle or second chain; a case, readiness or count disagreement; an unknown or
future code) proves no specific condition and is a 409 `INTAKE_BASIS_NOT_ESTABLISHED`; nothing is stored. A stored
`EXTERNAL_FINANCIAL_EVIDENCE_ABSENT` or any other normal outcome establishes nothing: there is no automatic scan,
backfill or inferred exception.

## Identity and replay

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
A stored intake answers a replay only when its contract, organization, Claim, source kind, source record, source
contract and reason are exactly the request's and this tenant's, and its identity key is the digest of its own
columns; otherwise the request is refused (409 `EXCEPTION_INTAKE_CONFLICT`). The basis is part of the stored
historical fact, not of the identity: a replay returns the original basis even after the source later changed.
