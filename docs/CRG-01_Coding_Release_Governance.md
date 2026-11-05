# CRG-01 FINAL Medical Coding Release Governance — Contract Register (CRG-CODESET-1)

CRG-01 FINAL (v2.0) supersedes CRG-01 v1.0. Version 1.0 was never merged; its tables, decision names and branch are
gone, so there is one authority only. This register covers **Checkpoint A**: the coding-release foundation. It is a
read-only resolver with five append-only records. For each encounter code, it selects the approved coding edition that
governs the encounter's own service date and regulatory scope. It then checks the code against exactly that edition and
answers with the full basis. A3 `ReferenceDatasetVersion` stays the edition authority.

Checkpoint A does not:

- block a claim or write a validation finding, receipt, handoff or freeze;
- change an encounter, an A2 master code, an A3 dataset or version, or any A1–A8 contract;
- import a licensed catalogue or store descriptor text;
- treat the 2027 transition as verified law.

| Checkpoint | Scope | Status |
|---|---|---|
| A | Identity, rights, import integrity, membership, retirement classification, pure resolver, read route | This package |
| B | A5-VAL-2 validator, coding receipts, PreClaimA6HandoffV2, A6-PAYLOAD-2, freeze V2 | Separate, later package |
| C | A7/A8 read side, A9 adapter contract | Separate, later package |

Regulatory compliance is **not established** by Checkpoint A. The source register is DRAFT, every real code system's
rights are BLOCKED, and Checkpoints B and C, A9 and A10 are still pending.

## Start gate and decisions

- The branch is `fix/crg-01-final-coding-release`. It starts from the main that contains A8.3 (PR #101,
  `a9f15806f4a178250b4aa263874a2b5c17ba827c`) and the harness correction
  `fix/a5-10-a7-2-harness-later-phase-recognition`. That correction is described in `docs/Harness_Corrections.md`
  and was merged first. It makes A5.10 T112 and the A7.2 replay check judge their own scope, so neither judges this
  package by a name. CRG-01 proves its own US-runtime boundary in CRG-009.
- **Bundled harness correction (disclosed).** By the head developer's decision, this PR also changes A7.2 T026,
  A7.3 T105, A7.4 T107 and A7.5 T108. Each of those checks refused CRG-01's `crg_release_imports` by the word
  `import`. Each now subtracts only the tables created by migrations committed after its own merge, the same rule as
  the accepted A6.10 T110 and A8.1 T100/T119 corrections. The change is two code lines per suite. CRG-003 proves it
  is exactly that. See `docs/Harness_Corrections.md`, "A7.2–A7.5 later-phase table recognition".
- Architecture-owner decisions (2026-11-04):
  - reuse A3 `ReferenceDatasetVersion`;
  - historically applicable `VALIDATED` editions, including `ACTIVE` and `SUPERSEDED`;
  - explicit retirement semantics that fail closed;
  - CRG-owned code-system identity and immutable membership tables;
  - the code system is never inferred from DHA;
  - synthetic editions only.
- Head-developer decisions (2026-11-04), delegated by the architecture owner:
  1. The mapping purpose is `CLAIM_CODING`.
  2. An import record is required. It holds the source file SHA-256 and the expected row count, and the import is all
     or nothing.
  3. Rights are recorded per code system as `APPROVED` or `BLOCKED`. The default is `BLOCKED`, and the latest numbered
     decision governs.
  4. A retirement is classified `PROSPECTIVE` or `HISTORICALLY_INVALIDATED`. An unclassified retirement fails closed.
  5. The CRG IDs Checkpoint A can prove are executed. Checkpoint B and C IDs are reported DEFERRED, and pre-production
     obligations are reported BLOCKED. Neither is ever counted as PASS.
  6. The decision codes `AMBIGUOUS_CODE_SYSTEM` and `SOURCE_INTEGRITY_CONFLICT` are added.
- The source is `docs/CRG-01-CODING-SOURCE-REGISTER.md`, entry SRC-01 (DHA GC 06-2026), with status **DRAFT**.

## Route and permission

| Route | Permissions | Answer |
|---|---|---|
| `GET /api/encounters/:encounterId/coding-release-check` | `encounter.read` + `codingRelease.read` (Admin, Viewer) | 200, one decision per current diagnosis and coded activity |

- A request with no session gets 401. A member without a permission gets 403.
- Another organization's encounter gets the same 404 as a missing one.
- A malformed id gets 400.
- Any query parameter or body (a date, edition or as-of selector) gets 400.
- A stored history that contradicts itself, or a code that belongs to another organization, gets 409
  `SOURCE_INTEGRITY_CONFLICT`. No partial answer is returned.

The read runs in one READ ONLY snapshot and writes nothing, not even an audit. There is no write, catalogue, code
search, activation or claim-block route.

## Resolution rules (pure resolver)

1. **Date and scope.**
   - Only `Encounter.serviceDate` is used. A submission, validation, record or current date never is.
   - The jurisdiction and authority come from the encounter's facility regulatory profile, compared trimmed and
     upper-cased.
   - Dubai is never assumed.
2. **Candidates.** A candidate edition must:
   - belong to a dataset mapped to exactly the code system, with purpose `CLAIM_CODING`, in that jurisdiction and
     authority;
   - have an `effectiveFrom` on or before the date;
   - have no `effectiveTo`, or one on or after the date.

   An undated edition is never selected.
3. **Rights.** The latest numbered rights decision for (jurisdiction, authority, code system) must be `APPROVED`. If it
   is `BLOCKED` or there is no decision, a covering edition answers `RELEASE_NOT_AUTHORIZED`.
4. **Approval.** An edition is approved when all of these hold:
   - it is `VALIDATED`;
   - it is `ACTIVE` or `SUPERSEDED`, or `RETIRED` and classified `PROSPECTIVE`;
   - its immutable A3 lifecycle shows at least one `ACTIVATE` or `ROLLBACK`;
   - it has a complete CRG import.

   A `SUPERSEDED` edition keeps governing its own dates.
5. **Retirement.**
   - A `RETIRED` edition classified `PROSPECTIVE` keeps its proven historical authority.
   - A `RETIRED` edition classified `HISTORICALLY_INVALIDATED`, or not classified at all, refuses its dates with
     `RELEASE_NOT_AUTHORIZED`.
6. **Edition outcome.**
   - Nothing covers the date: `NO_APPROVED_RELEASE`.
   - Something covers it but none is approved: `RELEASE_NOT_AUTHORIZED`.
   - More than one approved edition: `CONFLICTING_RELEASES`.
   - Exactly one approved edition: that edition. Never the newest, and never one chosen by id.
7. **Code identity.**
   - A diagnosis takes the single diagnosis system mapped for the scope. If none is mapped the answer is
     `NO_APPROVED_RELEASE`; if more than one is mapped it is `AMBIGUOUS_CODE_SYSTEM`.
   - A procedure must state exactly a controlled procedure system and an external code. Its internal code is never
     read.
   - A non-canonical value is `AMBIGUOUS_CODE_SYSTEM`.
8. **Membership.** The canonical code must be a member of exactly the selected edition: `APPLICABLE`, otherwise
   `CODE_NOT_IN_RELEASE`. The membership's release checksum must equal the edition's content hash.
9. **Consistency.** A history that contradicts itself refuses the whole read. Examples:
   - a mapping that no longer matches its dataset;
   - a version state its lifecycle does not explain;
   - an `ACTIVE` edition that is not `VALIDATED`;
   - a malformed or inverted window;
   - an import whose row count or checksum disagrees.

Controlled vocabulary:

- **Code systems:** `ICD-10-CM` (diagnosis), `CPT` and `HCPCS-LEVEL-II` (procedure).
- **Mapping purpose:** `CLAIM_CODING`.
- **Rights:** `APPROVED`, `BLOCKED`.
- **Retirement:** `PROSPECTIVE`, `HISTORICALLY_INVALIDATED`.
- **Decision codes:** `APPLICABLE`, `CODE_NOT_IN_RELEASE`, `NO_APPROVED_RELEASE`, `CONFLICTING_RELEASES`,
  `RELEASE_NOT_AUTHORIZED`, `AMBIGUOUS_CODE_SYSTEM`.

## Answer

The check returns `contractVersion`, `encounterId`, `serviceDate`, `jurisdictionCode`, `authorityCode`, `items` and
`evaluatedAt` (database UTC).

Each item has `subjectKind`, `subjectId`, `masterCodeId`, `decisionCode`, `codeSystem`, `edition` and `membership`:

- `edition` carries `referenceDatasetVersionId`, `datasetId`, `codeSystem`, `purpose`, `edition`, `effectiveFrom`,
  `effectiveTo`, `sourceVersionId`, `contentHash`, `importId`, `activationStatus` and `retirementClassification`.
- `membership` carries `membershipId`, `sourceRowId`, `sourceRowSha256` and `releaseContentHash`.

The code value itself is clinical and stays in its A2 owner. No patient, descriptor, amount or payer value is returned.

## Records

```text
reference_datasets (A3) ──1:1── crg_code_system_datasets      (code system + CLAIM_CODING, scope copied from A3)
        │
reference_dataset_versions (A3) ──1:1── crg_release_imports    (source SHA-256 = A3 contentHash, expected rows)
        │                                     │
        │                                     └──1:n── crg_release_code_memberships (code, source row, row SHA-256)
        └──1:1── crg_retirement_classifications (RETIRED editions only)

crg_code_system_rights   (jurisdiction, authority, code system, sequence) → APPROVED | BLOCKED
```

**`crg_code_system_datasets`**

- One code-system identity per A3 dataset (`dataset_id` unique, RESTRICT).
- It holds the system, the purpose, the jurisdiction, the authority and the contract.
- The insert guard holds the database's own time, and a jurisdiction and authority equal to the dataset's.

**`crg_code_system_rights`**

- Numbered decisions per (jurisdiction, authority, code system), each with its status and decision reference.
- The guard requires the next sequence number. The latest decision governs.

**`crg_release_imports`**

- One import per edition (`dataset_version_id` unique, RESTRICT), with the source file SHA-256, source URI, publisher
  and expected row count (1..5000).
- The insert guard checks three things: the edition's mapped system, a source SHA-256 equal to the A3 content hash,
  and that the edition is not yet validated or activated (sealed).
- A DEFERRABLE INITIALLY DEFERRED constraint trigger runs at commit. It refuses the commit unless the rows reach exactly
  the declared count and reproduce the SHA-256.

**`crg_release_code_memberships`**

- Each row holds a code, a source row id, a source row SHA-256 and the release checksum.
- Unique per (edition, system, code) and per (import, source row).
- The guard checks three things: rows are written only in their import's own transaction; the rows carry exactly the
  import's edition and system; and the import does not go past its declared count.

**`crg_retirement_classifications`**

- One classification per edition. Only a `RETIRED` edition can be classified.

The release fingerprint is the SHA-256 over the rows ordered by `sourceRowId`. Each row is one line:
`sourceRowId<TAB>code<TAB>sourceRowSha256<LF>`. The database recomputes it at commit.

All five tables refuse every UPDATE, DELETE and TRUNCATE. No A1–A8 table is altered. A3's activation lifecycle (one
`ACTIVE` per dataset, `ACTIVE` implies `VALIDATED`, immutable lifecycle events) is read and never redefined.

## Maintenance writers (no HTTP route)

- The writers are:
  - `registerDatasetCodeSystem({ datasetId, codeSystem, purpose })`;
  - `recordRightsDecision({ jurisdictionCode, authorityCode, codeSystem, rightsStatus, decisionReference })`;
  - `importRelease({ datasetVersionId, sourceFileSha256, sourceUri, publisher, expectedRowCount, rows })`;
  - `classifyRetirement({ datasetVersionId, classification })`.
- Each takes strict inputs, never accepts descriptor text, and runs in one SERIALIZABLE transaction with no retry.
- An import checks the row count and fingerprint before any write. It then locks the A3 dataset row first, as every A3
  lifecycle write does.
- A hash or count conflict is `SOURCE_INTEGRITY_CONFLICT`. A duplicate or sealed record is `CODING_RELEASE_CONFLICT`.
- In Checkpoint A they prepare synthetic editions only.

## Integration point

`getCodingReleaseCheckOf(encounterId, tx)` reads on the caller's transaction. It is the point the Checkpoint B
validator (A5-VAL-2) will consult. Old `A5-VAL-1` runs and findings are never touched.

## Acceptance

`npm run test:crg-01:coding-release` reports each of CRG-001…CRG-130 exactly once:

- **EXECUTED (69):** everything Checkpoint A can prove.
- **DEFERRED (56):** Checkpoint B (40) and Checkpoint C (16).
- **BLOCKED (5):** CRG-114, 116, 118, 128 and 129.

It also reports the build gates CRG-G01…G06. It nests the full A8.3 → A1 regression chain.
