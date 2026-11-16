# A8.10 Exception Operations Integration Acceptance & Phase Closure — Register (A8-PHASE-ACCEPTANCE-1)

`A8-PHASE-ACCEPTANCE-1` is a documentation and test-evidence label only. It is not an API, SQL object, business contract
or runtime state. A8.10 adds no migration, Prisma model, table, permission, audit action, route, reducer, writer, job,
queue, SLA, external adapter or frontend change. Its only files are:
- the harness `backend/src/integration/a8-phase-closure/a8-phase-closure.integration.ts`;
- the script `test:a8:phase-closure` in `backend/package.json`;
- this register;
- one disclosed correction to an earlier harness, recorded in `docs/Harness_Corrections.md` §4:
  `backend/src/integration/crg-01-coding-release/crg-01-coding-release.integration.ts` (CRG-G08 only; see Decisions).

## Start gate

- **Predecessors (actual merges on main).**

  | Package | PR | Merge | Accepted HEAD |
  |---|---|---|---|
  | A8.5 | #104 | `0f8f9d3` | — |
  | CRG-01 Checkpoint B | #105 | `4869df3` | `cdd5212` |
  | A8.6 | #106 | `18de6c8` | `f8ea4d2` |
  | A8.7 | #107 | `8af1891` | `194430b` |
  | A8.8 | #108 | `012d6fd` | `76aaaa2` |
  | A8.9 | #109 | `bb82b01` | `34608a9` |

- **A8.4.** A8.4 was closed by the architecture owner on 2026-11-04 as a duplicate of A8.3. It has no module, table,
  migration, route, suite or script, and A8.10 never recreates it.
- **CL-01.** CL-01 is resolved as the architecture owner approved it on 2026-11-13:
  - `RESOLVED_INTERNAL` with `NO_ESCALATION` is eligible on its A8.7 decision.
  - `RESOLVED_INTERNAL` with an A8.8 return for `FOLLOWUP_RECORDED` is eligible on that return.
  - A return for `FURTHER_WORK_REQUIRED` is refused in v1.
  - An outstanding escalation is refused (CL-02).
  - A8.10 tests only these accepted, reachable combinations and adds no bridge state.
- **Branch.** `feature/a8-10-phase-closure` is cut from clean, synchronized main holding the A8.9 merge, with remote
  parity. It is not stacked, and the working database is never reset.
- **Drafting disclosure.** The A8.9 review was delayed and the architecture owner asked for the work to continue. The
  harness was therefore drafted in a throwaway local clone, before the A8.9 merge. Nothing was committed to the
  repository, pushed or opened as a PR. This branch was cut only after the A8.9 merge, and both acceptance runs are made
  at its final pushed HEAD.

## Accepted owners (read through each owner only)

| Owner | Contract | Table | Events | States |
|---|---|---|---|---|
| A8.1 intake | `A8-EXCEPTION-INTAKE-1` | `exception_intake_records` | (record) | — |
| A8.2 triage | `A8-EXCEPTION-TRIAGE-1` | `exception_triage_events` | `TRIAGE_CLASSIFY`, `ASSIGN_OWNER`, `REASSIGN_OWNER`, `RETURN_TO_TRIAGE` | `UNTRIAGED`, `TRIAGED`, `ASSIGNED` |
| A8.3 investigation | `A8-EXCEPTION-INVESTIGATION-1` | `exception_investigation_events` | `LINK_EVIDENCE_REFERENCE`, `RECORD_FINDING` | `NOT_STARTED`, `FINDING_RECORDED` |
| A8.5 plan | `A8-REMEDIATION-PLAN-1` | `exception_remediation_events` | `PROPOSE_ACTION`, `REVIEW_ACTION` | `NO_PROPOSAL`, `AWAITING_REVIEW`, `APPROVED_FOR_PLANNING`, `RETURNED_FOR_REVISION` |
| A8.6 work | `A8-REMEDIATION-WORK-1` | `exception_remediation_work_events` | `RECORD_WORK_REPORT`, `VERIFY_WORK_REPORT` | `NO_WORK_REPORT`, `AWAITING_VERIFICATION`, `VERIFIED_INTERNAL_WORK`, `NOT_VERIFIED` |
| A8.7 resolution | `A8-RESOLUTION-DECISION-1` | `exception_resolution_events` | `REQUEST_INTERNAL_RESOLUTION`, `DECIDE_INTERNAL_RESOLUTION` | `NO_RESOLUTION_REQUEST`, `AWAITING_RESOLUTION_DECISION`, `RETURNED_FOR_REWORK`, `RESOLVED_INTERNAL` |
| A8.8 escalation | `A8-ESCALATION-1` | `exception_escalation_events` | `ESCALATE_FOR_REVIEW`, `ACKNOWLEDGE_ESCALATION`, `RECORD_FOLLOWUP`, `RETURN_TO_OWNER` | `NO_ESCALATION`, `AWAITING_ACKNOWLEDGEMENT`, `FOLLOWUP_ACTIVE`, `RETURNED_TO_OWNER` |
| A8.9 closure | `A8-CLOSURE-1` | `exception_closure_events` | `CONFIRM_INTERNAL_CLOSURE` | `NO_CLOSURE`, `CLOSED_INTERNAL` |

These are eight different positions held by eight different owners, not interchangeable "done" flags.
`CLOSED_INTERNAL` (A8.9) is distinct from `RESOLVED_INTERNAL` (A8.7), and both are distinct from every A6 and A7
state. None of them means paid, denied, transmitted, remitted, reconciled or clinically cured.

## Worked synthetic workflows (W1–W8)

Every fixture is synthetic, in two synthetic AE-DU/DHA organizations. It is built only through the accepted owner
routes by members provisioned per run. Direct SQL is adversarial only and always rolled back. The exact IDs and answers
of each run are printed in that run's log.

- **W1, clean terminal exception.** An A6 Claim frozen twice without an A6.9 link (the A7.7 contradiction) is the A8.1
  basis. It is carried through these steps:
  - A8.2: classified and assigned.
  - A8.3: linked and a finding recorded.
  - A8.5: proposed and approved by an independent reviewer (planning only).
  - A8.6: reported, then verified `EVIDENCE_SUPPORTED` by an independent verifier.
  - A8.7: requested, then confirmed `RESOLVED_INTERNAL` by an independent decider.
  - A8.8: `NO_ESCALATION`.
  - A8.9: one human closure on the decision. Its reconstruction names every owner's exact IDs.
- **W2.** A8.6 `EVIDENCE_NOT_VERIFIED`. A8.7 refuses a request (`BASIS_NOT_VERIFIED`) and A8.9 refuses the closure.
- **W3a and W3b.** A8.8 `AWAITING_ACKNOWLEDGEMENT` and `FOLLOWUP_ACTIVE`. A8.9 refuses (CL-02).
- **W4a and W4b.** A8.8 returned for `FOLLOWUP_RECORDED` is closed on that return. A return for `FURTHER_WORK_REQUIRED`
  is refused in v1. Both escalation histories read `RETURNED_TO_OWNER` exactly as recorded.
- **W5.** A Claim with no intake is 404 on every A8 route. A history planted with a gap (rolled back) gives 409
  `INTEGRITY_CONFLICT` and no partial reconstruction.
- **W6.** Org B's members get an indistinguishable 404 on every A8 route for Org A's IDs, and write nothing.
- **W7.** These use synthetic CRG-01 editions in a synthetic organization: `2021` (to 2026-12-31) and `2027` (from
  2027-01-01), created and activated through the CRG owner routes.
  - A 2026-12-31 service keeps the `2021` edition, also after `2027` is active and on its correction.
  - A 2027-01-01 service selects `2027`.
  - A legacy V1 freeze stays `LEGACY_PROVENANCE_UNVERIFIED`.
- **W8.** A6 freezes, lifecycle and corrections and A7 records are observed read-only and stay unchanged. There is no
  payer, payment, denial, balance or settlement fact.

## Regression chains

`test:a8:phase-closure` runs two suites, one after the other, never in parallel:
1. `test:a8:exception-closure` (A8.9 → A8.8 → … → A8.1 → A7.10 → … → A1).
2. Then `test:crg-01b:coding-validation` (CRG-01B → CRG-01A, plus the A8.5 chain).

Every nested FAIL line is kept verbatim in the run's evidence log, with its category (BRANCH, HEAD, SCOPE or
AGGREGATE) and its replacement proof on this branch. A substantive failure is never counted as N/A.

## Decisions (head developer, 2026-11-13)

- **Preparation before the A8.9 merge.** It was made outside the repository; see the drafting disclosure.
- **CRG-A/B compatibility.** The CRG-01B suite runs after the A8.9 chain, one after the other.
- **W7.** The harness creates and activates its own synthetic editions through the CRG owner routes. There is no real
  activation.
- **Harness correction bundled in this PR (2026-11-16).** CRG-01A's CRG-G08 failed on this branch for a reason that
  has nothing to do with the branch. A8.9's accepted table `exception_closure_events` matches the `closure` term of the
  A7.4/A7.5 patterns, and CRG-G08 assumed only `crg_release_imports` would match. The A7.4 T107 and A7.5 T108 checks
  themselves PASS.
  - The fix: CRG-G08 now recognizes the tables of accepted later owners by provenance, meaning a migration merged to
    main after Checkpoint A and byte-identical at HEAD. It never goes by name, and every V1 term is kept.
  - Negative test: a hand-made closure-named table, created by no migration, is still refused by both closure
    patterns.
  - Rejected: renaming A8.9's table (a bypass) and marking CRG-G08 N/A (a weakening).
  - T010 proves the change stays inside CRG-G08's review block, and T114 requires CRG-G08 to PASS.
  - Details are in `docs/Harness_Corrections.md` §4.
- **T120 risk.** The auditor was told before A8.10's runs that the first A8.9 attempt had 3 transient 5xx answers
  after the planned DB restart. If any 5xx appears, A8.10 stops and the owning shared code is corrected under a separate
  approved PR.

## Boundary and handoff

A8 phase engineering acceptance only. It does not establish any of the following:
- payer receipt, adjudication, rejection resolution, payment, remittance or cash closure;
- licensed code compliance, real DHA/DOH coding rights or activation;
- any eClaimLink/DHPO submission;
- production readiness.

The official DHA circular CIR-2026-00000200 (External GC 06-2026) is not an activation decision. Inpatient DRG
groupers and base rates are outside this outpatient V1 acceptance.

A8 phase engineering acceptance does not equal any of these:
- an A9 integration approval;
- an A10 production authorization;
- an A11 pilot release.

Open risks handed to A10 Production Hardening (open, not resolved here):
- **A10-RISK-01, transient HTTP 5xx after a database restart** (raised at the A8.9 PR #109 audit).
  - What happened: in A8.9's first official attempt `A89-1794585413824`, 3 of 42 concurrent reads straight after a
    planned database restart answered `INTERNAL_ERROR`. No row or audit changed.
  - Not reproduced: 4 further restart rounds and both accepted A8.9 runs answered 0 5xx.
  - Cause not confirmed, because the error handler does not log the underlying error.
  - A10 scope: database restart recovery, connection handling, readiness checks and diagnostic logging.
  - It may be closed only with A10 evidence. The record is `A10_RISK_A89-POST-RESTART-5XX.md` in the A8.9 evidence
    supplement.

Formal owner acceptance is separate from this test output. There is no self-merge.
