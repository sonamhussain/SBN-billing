# A6 Claim Lifecycle — Phase Closure Record (A6.10)

This record closes the A6 phase. It lists the accepted packages, the contracts A7 may rely on, the evidence the
A6.10 acceptance run produces, the documented nested N/A items and what remains open. A6.10 adds no migration,
table, permission, route, audit action, error code or frontend page.

Run IDs, the exact tested HEAD and the A6.10 merge SHA are produced by the two official runs and the merge
itself, so they are recorded in the A6.10 pull request and the review record, not in this file.

## Accepted packages (merged into `main`)

| Package | Contract(s) | Merge |
|---|---|---|
| A6.1 Claim foundation and A5 handoff binding | A6-CLAIM-1, PreClaimA6HandoffV1 | #74 `430e1b5` |
| A6.2 Claim lines, diagnoses and source traceability | A6-LINE-1, A6-DX-1 | #75 `890e0fd` |
| A6.3 Tariff rates and claim pricing | A6-PRICE-1 | #76 `bdf5674` |
| A6.4 Claim draft integrity | A6-DRAFT-1 | #78 `78c5d57` |
| A6.5 Human review and submission approval | A6-REVIEW-1 | #80 `e998e22` |
| A6.6 Canonical claim payload | A6-PAYLOAD-1 | #81 `4157275` |
| A6.7 Immutable ClaimSubmission and evidence package | A6-SUBMISSION-1, A6-EVIDENCE-1 | #82 `df27ed3` |
| A6.8 Internal lifecycle and transition governance | A6-LIFECYCLE-1 | #83 `2677aeb` |
| A6.9 Correction and resubmission lineage | A6-CORRECTION-1 | #84 `0e73803` |

Corrective PRs merged in this phase: #77 `7eebb3f` (A5.5 pricing-permission boundary) and #79 `c5dd475` (A5.6
rule-resolution candidate prefilter).

## Ownership register

| Owner | A6.10 consumes and proves | A6.10 never re-owns |
|---|---|---|
| A5.8–A5.10 | validation-run provenance, readiness version, the exact A6 handoff | eligibility/rule resolution, handoff selection, validation |
| A6.1–A6.2 | Claim identity and handoff; traceable lines, diagnoses, pointers | Claim models or clinical source copies |
| A6.3–A6.4 | historical rates and pricing runs; draft assessment, currentness, fingerprints | rate arithmetic, draft decisions, a pricing pointer |
| A6.5–A6.6 | human decision authority; canonical A6-PAYLOAD-1 bytes and hash | approver substitution, a second serializer |
| A6.7–A6.8 | frozen A6-SUBMISSION-1/A6-EVIDENCE-1; internal A6-LIFECYCLE-1 | frozen bytes, transport status, a lifecycle pointer |
| A6.9 | correction lineage between distinct immutable freezes | predecessor rewrites, ad hoc succession |
| A7–A10 | the boundary only | payment, denial, remittance, external exchange, infrastructure |

## The acceptance run

`npm run test:a6:integration` (backend) runs `backend/src/integration/a6-phase-closure/a6-phase-closure.integration.ts`:

- **T001–T010** — start gate, A6.1–A6.9 ancestry, clean tree, no schema/migration/route/permission change, toolchain
  and lockfiles, exact contracts, harness wiring, diff scope.
- **T011–T110** — one synthetic UAE (AE-DU/DHA) journey through every owner route: the real A5.8 engine and A5.9
  handoff, Claim, lines/diagnoses/pointers, pricing under the verified tariff version (AED 200.01 worked example),
  draft assessment, approval by a separate reviewer, canonical preview, freeze with evidence package, internal
  lifecycle events and a correction to an independently approved and frozen successor — with the adversarial
  cases of each owner, cross-module races, crash injection, tenant isolation, privacy and provenance read-back.
- **T111–T120** — the A6.9 suite, which nests A6.8 → A6.1 → A5.10 → A1; every documented failure is proved
  independently on the A6.10 branch.
- **T121–T130** — unit tests, typecheck, frontend lint/build, migration checksums, from-empty replay in the scratch
  database, database outage and recovery, synthetic-only data, the worked journey reconstructed identically after
  a database restart, and exact head.

Direct database writes are adversarial only and always rolled back, except the one synthetic same-instant
validation run that A6.1/A6.3 also create (no owner path can). The working database is never reset.

## Documented nested N/A (justified, never substantive)

The A6.9 suite asserts facts about its own branch. On A6.10 these are obsolete by design; T120 proves each cause.

| A6.9 check | Why it cannot pass on A6.10 |
|---|---|
| A6.9 T001 Start gate | requires the A6.9 feature branch |
| A6.9 T004 Only the A6.9 migration | requires the branch to add its migration; it is now part of `main` |
| A6.9 T006 Migration replay | expects main's count plus its own migration; that migration is now in main's count |
| A6.9 T010 Diff scope | lists the paths A6.9 was allowed to change |
| A6.9 T120 Nested N/A causes proven | proves A6.8's causes against the A6.9 branch |
| A6.9 T130 Exact head | requires the deleted A6.9 upstream |

Each owner suite keeps its own historical N/A list unchanged (A6.9 for A6.8, A6.8 for A6.7, and so on).

## Migration checksum evidence

53 migrations; A6.10 adds none. T125 checks every applied checksum against its committed file. The A6
migrations, with the checksum stored when they were applied:

| Migration | Checksum |
|---|---|
| `20261004100136_a5_9_pre_claim_readiness_a6_handoff` | `96a6a42ce227…` |
| `20261010120300_a6_1_claim_foundation_a5_handoff` | `0f2d0f1c2536…` (applied from the committed LF blob) |
| `20261011090000_a6_2_claim_line_diagnosis_source_traceability` | `2864e8f81324…` |
| `20261013090000_a6_3_tariff_rate_claim_pricing` | `081ce01da8fb…` |
| `20261014090000_a6_4_claim_draft_integrity` | `d7f037dcf75c…` |
| `20261016090000_a6_5_human_review_submission_approval` | `3e9978a1a693…` |
| `20261017090000_a6_7_immutable_claim_submission_evidence` | `a7d29546e872…` |
| `20261018090000_a6_8_claim_lifecycle_transition_governance` | `1ed47d2c1f48…` |
| `20261019090000_a6_9_correction_resubmission_lineage` | `4a0aa77bd4a7…` |

With `core.autocrlf` the committed blob (LF) and its checkout (CRLF) are the same committed content. 52
migrations were applied from the checkout and A6.1 from the committed blob; none differs from its committed file.

## A7 handoff boundary (read-only)

| A7 receives as references | Not asserted by A6 |
|---|---|
| Claim id; immutable submission (freeze) ids; versioned payload SHA-256 and evidence seal | external payer receipt, authorization to send, remittance |
| A6.8 internal lifecycle derived from its exact history | payer or delivery status |
| A6.9 correction lineage and the independently frozen successor | denial, reversal, reprocessing or collection decisions |
| A6.3 pricing source and currency lineage | allowed amount, patient responsibility, contractual adjustment or payment |

Transaction-aware readers for later owners: `getFrozenSubmission(claimId, submissionId, tx)`,
`getCurrentLifecycle(submissionId, tx)` and `getCorrectionChain(claimId, tx)`. RELEASE_ELIGIBLE is an internal
decision; it never means submitted, received, adjudicated, accepted, paid or closed, and A6 deems no amount
receivable or collectible.

## Open items (recorded for A10 by the auditor, not fixed in A6)

- pg `client.query()` DeprecationWarning from A5.7 `validation-run.repository.ts` (`Promise.all` on a
  transaction); it becomes an error in pg@9. Logged, not silenced.
- Intermittent P2028 stalls and nested-run failures coincided with laptop Modern Standby; cause not proven.
- The 555 kB frontend chunk and the Vite dev-proxy keep-alive `ECONNRESET`.
