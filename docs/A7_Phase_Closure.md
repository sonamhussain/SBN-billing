# A7 Revenue Evidence — Phase Closure Record (A7.10)

This record closes the A7 phase as an **engineering** phase. It lists the accepted packages, the contracts later
phases may rely on, how the A7.10 acceptance run proves them, the documented nested N/A items, what is deferred to
A10 and where A8 and A9 begin. A7.10 adds no migration, table, model, permission, audit action, error code, route,
reducer, worker or frontend page; it adds one acceptance harness, one script and this file.

Acceptance label: `A7-PHASE-CLOSURE-1` (an acceptance contract, not a product contract or code constant).

Run IDs, log SHA-256 hashes, the exact tested HEAD and the A7.10 merge SHA are produced by the two official runs and
the merge itself. Committing them here would change the HEAD the runs must prove, so they are recorded in the A7.10
pull request and the review record, not in this file (as in A6.10).

## Engineering closure is not financial closure

| A7.10 asserts | A7.10 never asserts |
|---|---|
| A7.1–A7.9 contracts, history, guards and regressions pass at one exact HEAD | production readiness, payer approval, collection or accounting sign-off |
| every recorded source, classification, readiness, case, assessment, trace, timeline, delta and continuity fact is explainable from its owner | that a missing remittance is a denial, or that absence is a zero balance |
| external adjudication, payment and remittance evidence is **not established** in this synthetic-only phase | that any Claim is paid, closed, reconciled, settled or revenue-complete |
| A8 and A9 own exceptions and real payer exchange | any XML/X12/HL7/HIE transport, acknowledgement, ledger, write-off or AR posting |

## Accepted packages (merged into `main`)

| Package | Contract | Merge |
|---|---|---|
| A6.10 A6 integration acceptance and phase closure | (acceptance only) | #85 `1236220` |
| A7.1 Revenue evidence intake | A7-REVENUE-SOURCE-1 | #87 `8f8ee64` |
| A7.2 Evidence classification and normalization | A7-EVIDENCE-CLASS-1 | #88 `1aa41f2` |
| A7.3 Adjudication evidence readiness | A7-ADJ-READINESS-1 | #89 `83c50da` |
| A7.4 Revenue evidence case assembly | A7-REVENUE-CASE-1 | #90 `b17b556` |
| A7.5 Case closure prerequisite assessment | A7-CLOSURE-PREREQ-1 | #91 `7b29191` |
| A7.6 Closure basis trace | A7-CLOSURE-TRACE-1 | #92 `2986376` |
| A7.7 Revenue evidence timeline | A7-REVENUE-TIMELINE-1 | #93 `b568392` |
| A7.8 Correction-chain revenue evidence delta | A7-REVENUE-DELTA-1 | #94 `d61d2d1` |
| A7.9 Revenue evidence continuity and provenance gate | A7-REVENUE-CONTINUITY-1 | #95 `b37fb54` |

Corrective PR merged between A6.10 and A7.1: #86 `61ca719` (A6.7–A6.9 harness replay count at HEAD).

## Contract and interface register

| Owner | Records or projects | Transaction-aware export for later owners | Read routes |
|---|---|---|---|
| A7.1 `revenue-evidence` | immutable source registrations of known synthetic origin | `getRevenueSourceEvidenceOf(submissionId, tx)` | `/api/claim-submissions/:id/revenue-source-evidence`, `/api/revenue-source-evidence/:id` |
| A7.2 `evidence-classification` | stored, versioned classification with source fingerprint | `getClassificationsOf(sourceEvidenceId, tx)` | `/api/revenue-source-evidence/:id/classifications`, `/api/revenue-evidence-classifications/:id` |
| A7.3 `evidence-gate` | recorded readiness (never a payer decision) | `getReadinessOf(classificationId, tx)` | `/api/revenue-evidence-classifications/:id/adjudication-readiness`, `/api/adjudication-evidence-readiness/:id` |
| A7.4 `evidence-case` | immutable case header, entries, counts and manifest digest | `getCasesOf(submissionId, tx)` | `/api/claim-submissions/:id/revenue-evidence-cases`, `/api/revenue-evidence-cases/:id` |
| A7.5 `case-prerequisite` | immutable assessment with one controlled absent-prerequisite basis | `getPrerequisiteAssessmentsOf(caseId, tx)` | `/api/revenue-evidence-cases/:id/closure-prerequisite-assessments`, `/api/closure-prerequisite-assessments/:id` |
| A7.6 `closure-basis-trace` | read-only explanation of a recorded assessment | `getClosureBasisTraceOf(assessmentId, tx)` | `/api/closure-prerequisite-assessments/:id/basis-trace` |
| A7.7 `revenue-timeline` | root-to-tail Claim history across actual freezes | `getRevenueTimelineOf(claimId, tx)` | `/api/claims/:claimId/revenue-evidence-timeline` |
| A7.8 `revenue-delta` | adjacent-pair recorded-summary comparison, no monetary delta | `getRevenueDeltaOf(claimId, tx)` | `/api/claims/:claimId/revenue-evidence-delta` |
| A7.9 `revenue-continuity` | chain-wide evidence gaps without a closure decision | `getRevenueContinuityOf(claimId, tx)` | `/api/claims/:claimId/revenue-evidence-continuity` |

A7.7, A7.8 and A7.9 are read-only: one REPEATABLE READ, READ ONLY snapshot on the caller's client, no Claim lock,
no write, no audit; each requires `claim.read`, `claimFreeze.read`, `claimCorrection.read`, `evidenceCase.read`
and `evidenceCasePrereq.read`. Any query selector or body is a 400; another tenant's Claim is answered exactly like
a missing one (404); a contradiction is a 409 with no partial result.

## The acceptance run

`npm run test:a7:phase-closure` (backend) runs `backend/src/integration/a7-phase-closure/a7-phase-closure.integration.ts`:

- **T001–T010** — start gate, A6.10 and A7.1–A7.9 ancestry, clean tree, no schema, migration, permission, audit
  action or route change, unchanged contracts, diff scope.
- **T011–T040** — one synthetic journey through every owner route (two organizations; Claims with 0, 1, 3 and 4
  freezes): registration, classification, readiness, case, assessment, trace, timeline, delta and continuity, with
  explicit absence (no case, no assessment, an unclassified source, a source without readiness).
- **T041–T060** — adversarial history: a second root frozen through the real owner, self and wrong-Claim
  corrections refused by A6.9, and forks, joins, cycles, foreign and duplicate cases or assessments, unsupported
  contracts, malformed and mismatched digests and broken chronology planted in transactions that are always rolled
  back and judged by the production services; forged owner results judged by the production reducers.
- **T061–T070** — one read-only snapshot per read; A7.1–A7.5 and A6.9 writers held uncommitted.
- **T071–T080** — 401, 403 (a member holding no grant), foreign = missing 404, 400 selectors and spoofing, privacy,
  no audit on read.
- **T081–T090** — stable bytes, time zone and locale, old freezes, links, cases, assessments and comparisons after
  the chain grows, read-back after a database restart.
- **T091–T100** — phase boundaries: no payer send, adjudication, payment, patient responsibility, receivable,
  adjustment, ledger, A8 exception workflow or A9 adapter.
- **T101–T111** — the A7.9 suite, which nests A7.8 → A7.1 → A6.10 → A1; every documented failure is proved
  independently on the A7.10 branch.
- **T112–T130** — unit tests, typecheck, frontend lint and build, every migration checksum and the from-empty
  replay, database outage and recovery, no 5xx, synthetic-only data, A10 warnings, exact head, explicit results,
  retained nested output, the golden scenario after the nested chain and a restart, and this record.

Direct database writes are adversarial only and always rolled back. The working database is never reset.

## Golden synthetic scenario

Claim C of the home organization has three independently approved freezes S1 → S2 → S3, linked through A6.9:

- S1 and S2 each carry one synthetic source, classified (A7.2), gated (A7.3: `NOT_READY_FOR_ADJUDICATION /
  EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT`), cased (A7.4: `INVENTORY_COMPLETE`) and assessed (A7.5:
  `EXTERNAL_FINANCIAL_EVIDENCE_ABSENT / EXTERNAL_REMITTANCE_NOT_ESTABLISHED`); A7.6 explains each assessment
  without re-assessing it.
- S3 has no case.
- A7.7 lists S1, S2, S3 in link order; A7.8 compares S1/S2 (`RECORDED_SUMMARY_CHANGED`) and S2/S3
  (`CASE_NO_LONGER_RECORDED`); A7.9 reads `HISTORICAL_EVIDENCE_UNRECORDED` with gaps
  `EXTERNAL_FINANCIAL_EVIDENCE_ABSENT`, `EXTERNAL_FINANCIAL_EVIDENCE_ABSENT`, `CASE_NOT_RECORDED`.
- A later independent freeze S4 linked to S3 leaves every earlier freeze, link, case, assessment, comparison and
  gap byte-identical; A7.9 only appends S4's gap.

None of these codes says money is due, posted, collected, denied or closed.

## Documented nested N/A (justified, never substantive)

The A7.9 suite asserts facts about its own branch. On A7.10 these are obsolete by design; T111 proves each cause.

| A7.9 check | Why it cannot pass on A7.10 |
|---|---|
| A7.9 T001 A7.8 FINAL PASS merge is an ancestor | requires the A7.9 feature branch |
| A7.9 T002 Clean HEAD and origin parity | requires tracking the deleted A7.9 upstream |
| A7.9 T010 Exact changed-file allowlist | lists the paths A7.9 was allowed to change |
| A7.9 T120 All historical branch-only N/A justified | proves A7.8's causes against the A7.9 branch |
| A7.9 T130 Two complete runs, exact HEAD parity | compares HEAD with the deleted A7.9 upstream |

Each owner suite keeps its own historical N/A list unchanged (A7.9 for A7.8, A7.8 for A7.7, and so on).

## Disclosed decisions (owner-approved)

- A7.9 output has no product consumer and A7.10 may add no reducer, so an unknown A7.9 contract or a missing or
  duplicated continuity gap (T053, T059) is refused by the harness's own acceptance cross-check against the A7.7
  timeline and the stored A7.4/A7.5 rows — the acceptance gate failing closed, not a product 409.
- Both existing roles hold all five reads, so T072 proves 403 with a synthetic member of the organization that
  holds no role, plus the route code chaining all five grants.
- "Two runs" (T123, T130): each run proves its own fresh run ID, the exact HEAD at start and end and origin parity;
  the pair is the two submitted logs.

## Deferred to A10 (recorded, not fixed in A7)

Known limitations, carried forward without hiding any failure:

- Frontend production chunk above Vite's 500 kB advisory (route-level code splitting).
- pg `client.query()` DeprecationWarning ("Calling client.query() when the client is already executing a query is
  deprecated") from concurrent queries on one transaction client; it becomes an error in pg@9. Logged, not silenced.
- TRUNCATE gap: append-only tables of A1–A6 have row-level UPDATE/DELETE guards only; a statement-level TRUNCATE
  guard per table is proposed as one hardening migration.
- Lock-wait starvation: the NOWAIT-and-retry Claim lock in the A6.4/A6.5/A6.7/A6.8/A6.9 services can return a safe
  409 "the claim stayed busy" under bursts (A7.1 fixed its own service).
- Time zone hazard: Prisma adapter-pg misreads `timestamptz` when the session TimeZone is not UTC; the database
  default is UTC today. Pin the session TimeZone and add a guard test.
- Intermittent P2028 stalls coincided with laptop Modern Standby; the cause is not proven.
- Vite dev-proxy `ECONNRESET` on idle keep-alive connections.
- Proposed (not yet reviewed by the auditor): a guarded retention policy for accumulated synthetic test data.

## A8 and A9 handoff boundary

| Later owner | Receives from A7 as read-only references | Never inferred by A7 |
|---|---|---|
| A8 exception operations | A7.9 continuity gaps, A7.5 assessments and A7.6 traces as the evidence an exception may cite; audit reconstruction from A7.1–A7.5 metadata-only audits | an exception, a work queue, a status or an assignment |
| A9 real payer integration | frozen submissions (A6.7), internal lifecycle (A6.8), correction lineage (A6.9) and the A7.1 source registration contract (today synthetic-only) | transmission, acknowledgement, adjudication, remittance or payment |
| Finance owners after A9 | the explained, immutable evidence history | allowed amount, patient responsibility, adjustment, write-off, receivable, ledger or closure |

`RELEASE_ELIGIBLE` (A6.8) is an internal decision; it never means sent, received, adjudicated, paid or closed.
`EXTERNAL_FINANCIAL_EVIDENCE_ABSENT` (A7.5) never means paid, denied, zero balance or closed. Business revenue
closure awaits authorized external evidence and accounting capabilities. A10 hardens production; A11 covers
integration, deployment and UAT.
