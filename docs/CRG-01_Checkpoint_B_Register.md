# CRG-01 FINAL — Checkpoint B Register (versioned coding validation and freeze)

Checkpoint B is implemented under the approved design freeze, revision 1.2 (`CRG-01_Checkpoint_B_Design_Freeze_v1.2`).
Revision 1.1 was architecture-approved on 2026-11-06, subject to the historical-verification clarification. That
clarification is finalized in revision 1.2 §10; no new review was required.

Regulatory compliance remains **NOT ESTABLISHED**:
- only SYNTHETIC validation scopes exist;
- every real DHA/DOH scope stays disabled;
- licensed production imports, production activation and Checkpoint C are out of scope.

## Baseline

- Branch `feature/crg-01b-coding-validation-freeze`, cut from clean, synchronized main
  `0f8f9d3bc18347b1360b72b93056724b594a6e00`.
- That main contains Checkpoint A (PR #103, `c8ebf2c4cc385dadeaacafca0bca69db5c534b7a`) and A8.5 (PR #104).
- Checkpoint A (`CRG-CODESET-1`) is reused unchanged as the edition authority.

## Scope

**Three new CRG tables:**
- `crg_validation_scopes` (`CRG-VALSCOPE-1`);
- `crg_validation_code_receipts` (`CRG-RECEIPT-1`);
- `crg_validation_receipt_manifests` (`CRG-RECEIPT-1`).

**Seven new contract versions:**
- `A5-VAL-2`, `A5-READY-2`, `PreClaimA6HandoffV2`;
- `A6-PAYLOAD-2`, `A6-SUBMISSION-2`;
- `CRG-RECEIPT-1`, `CRG-VALSCOPE-1`.

Every V1 contract (A5-VAL-1, A5-READY-1, PreClaimA6HandoffV1, A6-PAYLOAD-1, A6-SUBMISSION-1, A6-EVIDENCE-1) is
unchanged, together with its golden vectors and every historical byte.

**Migration `20261106090000_crg_01b_coding_validation_freeze`.** It adds the three tables, plus these guards and
triggers:
- the scope insert guard (database time, the next number, class never changes, a REGULATORY scope starts ENABLED);
- the receipt and manifest insert guards (database time, an A5-VAL-2 run, nothing added after a manifest);
- the deferred manifest guard proving I1–I6 at commit;
- the deferred `crg_validation_runs_receipts_complete_trg` (no A5-VAL-2 run commits without its manifest);
- `crg_validation_runs_scope_guard_trg` and `crg_claim_freezes_scope_guard_trg` (no V1 run or freeze in a REGULATORY
  scope, none while it is SUSPENDED, and a freeze's version must match its Claim's handoff);
- append-only and no-TRUNCATE triggers on all three tables.

It redefines `claims_handoff_schema_version_chk`, `claim_freezes_payload_schema_version_chk` and
`claim_freezes_contract_version_chk` under their exact names, each as V1 or V2, and adds
`claim_freezes_version_pair_chk`. No applied migration is changed and no column is added to any A1–A8 table.

The CHECK `crg_validation_scopes_checkpoint_b_chk` admits SYNTHETIC scopes only. Replacing it is the separately
approved activation step.

**Routes (read only).** Both are `codingRelease.read`-gated, plus the owner's read permission:
- `GET /api/validation-runs/:runId/coding-receipts` (`validationRun.read`);
- `GET /api/claim-submissions/:submissionId/coding-provenance` (`claimFreeze.read`).

Each answers `VERIFIED_AS_RECORDED`, `LEGACY_PROVENANCE_UNVERIFIED`, or 409 `CODING_RECEIPT_INTEGRITY_CONFLICT`. There
is no write route. The scope writer `recordValidationScope` is a maintenance function with no HTTP route. No
permission or audit action is added; the only new error code is `CODING_RECEIPT_INTEGRITY_CONFLICT`.

## Behaviour by owner

- **A5.8.** The validator is the server's choice from the encounter's scope:
  - A5-VAL-2 where the latest decision is ENABLED;
  - A5-VAL-1 otherwise;
  - a SUSPENDED regulatory scope records no run (409).

  A5-VAL-2 adds one CODING finding and one receipt per active diagnosis and per procedure-coded activity, when the
  TECHNICAL layer passed. These are written on the one REPEATABLE READ transaction, after the A5-VAL-1 layers, which
  are unchanged. Modifiers are not evaluated by CRG.
- **A5.9.** An explicit dispatcher names one policy per validator: A5-READY-1 for A5-VAL-1, A5-READY-2 for A5-VAL-2.
  A5-READY-2 and PreClaimA6HandoffV2 also require the receipts to verify as recorded. The V1 composer branch is
  byte-identical.
- **A6.1, A6.2, A6.3, A6.4.** These accept PreClaimA6HandoffV1 or V2 through `isAcceptedHandoffSchema`. A6.2 diagnoses
  and A6.3 pricing reuse the A6.2 gate.
- **A6.6.** `A6-PAYLOAD-2` uses a separate encoder (`claim-payload.v2.ts`): the A6-PAYLOAD-1 schema plus a `coding`
  section binding each diagnosis and procedure-coded line to its receipt.
- **A6.7.** `A6-SUBMISSION-2` freezes A6-PAYLOAD-2 for a V2 claim. The composer re-verifies the receipts under the
  Claim lock. The evidence manifest (A6-EVIDENCE-1) and its seal are unchanged.
- **A6.5, A6.8, A6.9.** Unchanged and version-agnostic. A corrected claim is reviewed and frozen again and binds its
  own run's receipts, under the original service date's edition.

## Integrity and verification

**At commit, I1–I6 are proven against the live transaction:**
- I1 run and encounter;
- I2 target, master and code;
- I3 finding, target, code and edition;
- I4 exact set equality of required targets and receipts, and one receipt per coding-release finding;
- I5 release identity, scope, effective window and hashes;
- I6 manifest count and digest.

**Afterwards, H1–H5 re-derive only from immutable records:**
- receipts, manifest, run and findings;
- the Checkpoint A rows;
- the frozen bytes.

The resolver is never re-run for history. Current rights, activation, retirement, later editions, current target
activity and the current A2 masters are never read for history.

## Review corrections (PR #105, 2026-11-07)

**F05 — H5 compares complete frozen coding entries.** H5 no longer compares receipt identifiers alone. The pure
`verifyFrozenCoding` (`coding-validation.frozen.ts`):
- rebuilds the coding section from the frozen diagnoses and lines and the run's verified receipts, with the composer's
  own `codingSectionOf`, and requires it to equal the frozen section exactly. This covers each entry's claim diagnosis
  or line, encounter target, receipt, code system, edition, membership, source-row hash and order;
- requires each receipt to be of the entry's subject kind and to name the frozen diagnosis or procedure master;
- requires every recorded receipt to be bound exactly once.

Negative tests:
- the unit tests: swapped receipts, every altered entry field, every altered binding fact, coverage, order,
  uniqueness, manifest and shape;
- B-G03: the frozen bytes are rewritten with one swapped or altered binding and re-digested, so only the entry check
  can see the change; the unaltered rewrite is the control.

The frozen bytes, the composer, V1 and every migration are unchanged.

**pg driver warning.** Traced with `--trace-deprecation` and a preload probe. pg's "client.query() when the client is
already executing a query" deprecation came from concurrent statements on one interactive-transaction client. There
were two sources:
- explicit `Promise.all` reads on `tx`;
- Prisma's own parallel relation loading inside a transaction.

`shared/database/prisma.ts` now wraps the driver adapter (`serialized-transactions.ts`), so each transaction's
statements reach pg strictly one after another, in issue order. pg already queued them in that order; the statements,
isolation level, snapshot, results and errors are unchanged, and no module code changed. CRG-126 also requires that no
such warning appears in this process or in any process of either nested chain.

**Nested regression evidence.** CRG-124 writes every original nested FAIL line, verbatim, to
`crgb-nested-evidence-<runId>.log`, whose SHA-256 is in CRG-127. Each line carries its category:
- BRANCH: branch name or base ancestry;
- HEAD: clean tree, origin parity or a run's own identity;
- SCOPE: the paths that package was allowed to change;
- AGGREGATE: a suite's own branch-only justification, whose items are each re-proved here.

A line of any other kind fails CRG-124.

## Acceptance

The harness `test:crg-01b:coding-validation` (TAG `CRG-01B`) covers:
- governance gates CRGB-G01–G07 and B-G04;
- CRG-051–CRG-090 and CRG-119;
- B-G01–B-G06;
- cumulative regressions CRG-123–CRG-125: the Checkpoint A suite and the A8.5 suite, each nesting A8.3 down to A1;
- build gates CRGB-G08–G11, CRG-126 and CRG-127;
- CRG-122, two runs at one exact HEAD.

Fifteen earlier harnesses are corrected under design freeze §12. Each is listed in `docs/Harness_Corrections.md` with
its negative test, which runs in B-G06:
- three unknown-validator stand-ins (`A5-VAL-2` → `A5-VAL-9`);
- seven A7 cash-receipt boundaries, under the accepted later-phase table rule;
- three A6.7–A6.9 T009 owner terms, judged over the package's own range;
- two A5.8/A6.6 scan-reach guards, each admitting the one named Checkpoint B file.

The full clone proof found every one of them. None changes behaviour and none is marked N/A.

## Out of scope (Checkpoint C and later)

- the A7 trace of receipts and A8 exception mapping;
- the A9 adapter;
- any REGULATORY scope and production activation;
- DRG, pricing or payer logic;
- modifier validation.
