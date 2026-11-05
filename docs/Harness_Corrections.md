# Harness Corrections — Later-Phase Recognition and A6.6 Ordered Counts (before A8.1)

Branch `fix/a6-a7-harness-later-phase-recognition`, from `main` at `0a74f47` (A7.10 merge). Harness files only: no
product module, migration, schema, permission, audit action, route, frontend page or accepted contract changes. The
branch also carries its own acceptance suite (`npm run test:harness-corrections`, below).

## Why

The accepted A6.10 and A7.1–A7.10 harnesses run nested inside every later acceptance chain. Some of their checks
compared the **current branch** against `main` (`origin/main...HEAD`) or scanned the **whole live database** by table
name. On a package's own branch that is exactly right. On any later branch, though, it makes the earlier harness judge
the later package: a legitimate A8 migration, table or harness change fails an A6/A7 check that was never meant to
cover it. Two wrong fixes were rejected: renaming A8.1's table to dodge the name regexes (a bypass), and marking the
checks N/A (a weakening).

The correction keeps every original protection and changes only **what is judged**:

- **On the package's own branch**, every changed predicate is evaluated exactly as before (same range, same base,
  same live tables, same tree).
- **On any later branch**, the predicate judges exactly what that package itself merged: the range
  `<own merge>^1..<own merge>`, the migrations at its merge and at its merge's first parent, and the tree its merge
  produced. Tables a later phase adds are recognized by **provenance**: they are created by a migration committed
  after the package's own merge. Recognition never uses a table's name. Every table that existed when the package
  merged is still judged by the original name boundary.

No check was converted to N/A, removed, or given a weaker condition. The own merge is found with the harness's
existing `mergeOf(<own branch>)` against `origin/main`. The resulting set of later-phase tables is empty on the
package's own branch and on any branch with no later migration, so the predicate is unchanged there.

## Changed predicates

| Suite | Check | Before | After | Own branch |
|---|---|---|---|---|
| A6.10 `a6-phase-closure` | T110 later-phase boundary | every live table matching `(remittance\|payment\|adjudicat\|denial\|receivable\|outbox\|queue\|transmission\|acknowledg\|exception)` | the same regex over live tables, minus tables created by migrations committed after A6.10's merge | unchanged (empty set) |
| A7.1 `a7-revenue-source-evidence` | T009 owners untouched, T101 zero A6 changes | owner paths in `origin/main...HEAD` | owner paths in A7.1's own range | unchanged |
| A7.2 `a7-evidence-classification` | T009 owners untouched, including the accepted bundled A7.1 T060 fix | owner paths in `origin/main...HEAD`; the bundled-fix diff and blocks read from `origin/main...HEAD`, `origin/main:` and `HEAD:` | the same rules over A7.2's own range; the blocks are read at the own merge's first parent (resolved to its SHA) and at the own merge | unchanged |
| A7.3 `a7-evidence-gate` | T009, including the accepted bundled A7.2 harness fixes | as A7.2 | as A7.2, over A7.3's own merge | unchanged |
| A7.4 `a7-evidence-case` | T009, including the accepted bundled A7.3 T060 fix | as A7.2 | as A7.2, over A7.4's own merge | unchanged |
| A7.5 `a7-case-prerequisite` | T009 owners untouched; the owner term of T120 | owner paths in `origin/main...HEAD` | owner paths in A7.5's own range | unchanged |
| A7.6 `a7-closure-basis-trace` | T004 no migration | `migrationStatus` of `origin/main...HEAD`; HEAD migrations equal main's | prisma status of A7.6's own range; migrations at its merge equal those at its base | unchanged |
| | T006 replay base | applied count = main's migration count | applied count = HEAD's committed count (still required) and its own scope added none | unchanged |
| | T007 permission catalogue | authorization diff of `origin/main...HEAD` | authorization diff of the own range | unchanged |
| | T009 owners untouched; the owner term of T120 | `origin/main...HEAD` | own range | unchanged |
| | T109 later-phase boundary | live tables by name regex | the same, minus later-phase tables (provenance) | unchanged |
| A7.7 `a7-revenue-timeline` | T004, T005, T006, T007, T009; the owner term of T110 | as A7.6 | as A7.6 | unchanged |
| | T110 later-phase boundary | live tables by name regex | the same, minus later-phase tables | unchanged |
| | T115 migration status | applied = HEAD committed **and** HEAD migrations = main's | applied = HEAD committed (still required) **and** its own scope added none | unchanged |
| A7.8 `a7-revenue-delta` | T004, T006, T007, T009, T110; the owner term of T120 | as A7.7 | as A7.7 | unchanged |
| A7.9 `a7-revenue-continuity` | T004, T006, T007, T009, T110; the owner term of T120 | as A7.7 | as A7.7 | unchanged |
| A7.10 `a7-phase-closure` | T004 no product migration or model | `origin/main...HEAD` | own range | unchanged |
| | T007 no permission or audit action, T008 no route or sender | diffs and paths of `origin/main...HEAD` | diffs and paths of the own range | unchanged |
| | T091–T099 table inventory | every live table | every live table minus later-phase tables | unchanged |
| | T099/T100 tracked files | the tree at `HEAD` | the tree A7.10's merge closed; on its own branch, `HEAD` | unchanged |

"The owner term" of a nested-justification check (A7.5 T120, A7.6 T120, A7.7 T110, A7.8 T120, A7.9 T120) is only its
conjunct *"this package changed no owner file"*; every other conjunct of those checks is unchanged.

In every changed predicate, everything the live database, the replay and the API prove is still checked against the
live state at the tested HEAD. Examples: `db:status` up to date, applied count equal to HEAD's committed migrations,
every A6/A7 guard, trigger, route and reducer. Only the question *"did this package change X"* moved from the current
branch to the package's own merge.

## A6.6 T082 — order-independent counts

**Defect (found by the official runs of this branch).** A6.6 T082 "Previews write nothing" compares eleven
`count(*)` results joined by `UNION ALL`, serialized as one ordered string, with no `ORDER BY`. PostgreSQL may run such
a `UNION ALL` as a Parallel Append, which returns the rows in no guaranteed order. On a small database it ran
serially and the order never changed; at today's size (about 750,000 audit events) the nested chain gets a parallel
plan, so the same counts arrive in a different order and the check fails although nothing was written. A6.7 and every
later suite already key their counts by table for exactly this reason; A6.6 was the only one that did not.

**Evidence.** Two official runs (A710-1793281117696, A710-1793289117145) failed only on A6.6 T082 and its cascade. A
temporary instrumented run (reverted, never committed) recorded inside the chain: all eleven count values identical at
T071 and T082; every table's insert/update/delete statistics identical; no other session active; only the row
order differed. Run alone, the unmodified A6.6 passed T082.

| Suite | Check | Before | After |
|---|---|---|---|
| A6.6 `a6-canonical-payload` | T082 previews write nothing (`tableCounts`) | the eleven counts in the order PostgreSQL returned them | the same eleven counts, `ORDER BY t` |

Every count is still compared exactly; only the order is fixed.

## Acceptance of this correction (`npm run test:harness-corrections`)

A7.10 run on any branch but its own always fails its seven checks about its own branch, so it cannot be this
branch's final gate. `backend/src/integration/harness-corrections` is. Every check is executed, nothing is N/A
except the seven nested A7.10 items, each proved for its cause:

- **H01–H05 scope:** branch and ancestry; clean tree and origin parity; the exact changed files; no module, shared,
  script, job, app, server, prisma or frontend change, `package.json` differing only by this suite's script; every
  A1–A7 contract constant identical to main.
- **H06–H08 every check kept:** each corrected suite has exactly its check ids and titles from main, and a
  byte-identical N/A policy; every changed line is an own-scope definition or use, a comment, or the A6.6 `ORDER BY`.
- **H09–H12 equivalence and the later-phase rule:** every own-scope value is defined once from `ownMerge`, and on
  the package's own branch (`ownMerge = ''`) it is literally the original value. The excluded tables are computed
  only from migration files committed after the package's own merge, never from the database. At this HEAD no
  excluded table matches a boundary any suite enforces. A prohibited-looking table created outside any migration
  (inside a transaction that is always rolled back) is excluded by no suite.
- **H13–H17 full chain:** A7.10 → A1 run once. Every A7.10 substantive check PASSes (A7.9 … A7.1, A6.10 … A1, units,
  typecheck, build, replay, outage, warnings), and each of the seven branch-only A7.10 failures is proved for its own
  cause on this branch.
- **H18:** exact HEAD equal to origin, clean tree, and the full nested output kept in `backend/hc-nested-<run>.log`.

A later package (A8.1) proves its own tables: its own scope checks forbid any assignment, queue, payment, remittance
or other later-domain table, so a table the earlier suites exclude is never unjudged.

## What remains branch-only

These checks are unchanged and are still documented as branch-only N/A in a later package's nested chain. They prove
the package's own branch, ancestry, head, changed-file scope or acceptance register, and the parent proves its own:

- A6.10: T001, T004, T007, T010, T120, T130.
- A7.10 in the A8.1 chain: T001, T002, T010, T111, T122, T123, T130.

## Proof

- Typecheck clean; `npm run test:a3:scope` passes.
- A throwaway local clone of this branch, committed, runs the full chain through `npm run test:harness-corrections`.
- Two official `npm run test:harness-corrections` runs at one HEAD, each a complete PASS, with their full nested
  outputs.

---

# A8.1 later-phase recognition (before A8.2)

Branch `fix/a8-1-harness-later-phase-recognition`, from `main` at `6033d41` (A8.1 merge). It changes only the A8.1
suite, the A8.1 check of the migration replay script, this document, and a new acceptance suite with its one
package script. No product module, migration, schema, permission, audit action, route, frontend page or accepted
contract changes.

## Why

A8.1 runs nested inside every later acceptance chain, starting with A8.2. Some of its checks compared the
**current branch** against `main` or scanned the **whole live database** by table name. These are the same patterns
the first correction fixed in A6.10 and A7.1–A7.10. On the A8.2 branch they would judge A8.2, not A8.1:

- its migration would break T004 "one A8.1 additive migration only";
- its two permissions would break T007;
- its module would break T009;
- its `exception_triage_events` table would break T119 "no A8.2 assignment/status/export table" by name;
- its RESTRICT foreign key into `exception_intake_records` would make PostgreSQL refuse a plain `TRUNCATE` before
  A8.1's own guard runs, breaking T050;
- the replay check "the A8.1 tables are exactly exception_intake_records" would count A8.2's table by its name
  pattern.

The same two wrong fixes stay rejected: renaming A8.2's table and marking checks N/A. Neither is done.

## Changed predicates

| Check | Before | After | Own branch |
|---|---|---|---|
| A8.1 T004 one additive migration | prisma status of `origin/main...HEAD`; HEAD migrations = main's + 1, the newest A8.1's | the same over A8.1's own range: migrations at its merge = those at its merge's first parent + 1, the newest A8.1's | unchanged |
| A8.1 T007 narrow permission catalogue | catalogue at `HEAD` vs `origin/main` adds exactly `exceptionIntake.create`/`.read`; no other live `exception` permission | the catalogue at A8.1's merge vs its first parent; a live `exception` permission is accepted only if it was added to the catalogue **after** A8.1's merge | unchanged (no later permission) |
| A8.1 T009 earlier contracts and migrations | module paths and prisma status of `origin/main...HEAD` | the same over A8.1's own range; the contract constants are still compared at `HEAD` | unchanged |
| A8.1 T050 DELETE refused | DELETE and plain TRUNCATE refused by the append-only guard | DELETE refused by the guard; `TRUNCATE … CASCADE` (which reaches the guard past any foreign key) refused by the guard; plain TRUNCATE refused by the guard **or** by PostgreSQL because every key into the table is `ON DELETE RESTRICT`; nothing changed in any case | the plain TRUNCATE still reaches the guard (no key into the table) and the cascade case is an added refusal |
| A8.1 T100 and T119 later-phase boundaries | live tables matching the boundary regexes, minus main's tables | the same, minus tables created by migrations committed after A8.1's merge (from git, never by name) | unchanged (empty set) |
| Replay script, A8.1 tables | live tables whose name matches `exception\|intake` equal `[exception_intake_records]` | the tables the A8.1 migration file itself creates equal `[exception_intake_records]`, and each exists after the clean replay | the PASS text is unchanged, so A8.1 T006 reads it unchanged |

On A8.1's own branch, `ownMerge = ''`, and every own-scope value is literally the original. The values are
`origin/main...HEAD`, `origin/main`, `HEAD`, the same migration lists and catalogue, and no later-phase table or
permission. The T050 judgement is by behaviour, like the accepted A7.3 T060: every wipe is still refused and nothing
changes.

Everything the live database, the API and the replay prove is still checked at the tested HEAD.

## Acceptance of this correction (`npm run test:harness-corrections:a8`)

A8.1 run on any branch but its own always fails its checks about its own branch. So the final gate for this branch is
`backend/src/integration/harness-corrections-a8`, not A8.1. Every check is executed. Nothing is N/A except the
nested A8.1 branch-only items, each proved for its cause.

- **H01–H05 scope:**
  - branch from the main that contains the A8.1 merge;
  - clean tree and origin parity;
  - exactly the five changed files;
  - no module, shared, job, app, server, prisma or frontend change, and the replay script changed only in its A8.1
    check;
  - `package.json` differs only by this suite's script;
  - every contract constant identical to main.
- **H06–H08 every check kept:**
  - the A8.1 suite has exactly its 130 check ids and titles from main;
  - its N/A map and every N/A call are byte-identical;
  - every changed line is an own-scope definition or use, the behaviour-judged T050 refusal, a comment, or the
    replay's A8.1 table check.
- **H09–H12 equivalence and the later-phase rule:**
  - every own-scope value is defined once from `ownMerge` and is literally the original on A8.1's own branch;
  - excluded tables come only from migration files committed after A8.1's merge, never from the database;
  - at this HEAD nothing is excluded;
  - a prohibited-looking table created outside any migration (rolled back) is never excluded.
- **H13–H17 full chain:**
  - A8.1 → A7.10 → … → A1 run once;
  - every A8.1 substantive check PASSes, including the corrected T004, T006, T007, T009, T050, T100, T119 and T125,
    the A7.10 → A1 regressions T101–T109, and units, typecheck, lint, build, replay and outage (T121–T129);
  - each A8.1 branch-only failure is proved for its own cause on this branch.
- **H18:** exact HEAD equal to origin, clean tree, and the full nested output kept in `backend/hc8-nested-<run>.log`.

A later package proves its own tables. A8.2's own boundary checks judge `exception_triage_events` and forbid any
other later-domain table, so a table A8.1 excludes is never unjudged.

## What remains branch-only

These checks are unchanged. They are documented as branch-only N/A in a later package's nested chain, where the
parent proves its own versions:

- A8.1 in a later chain: T001, T002, T010, T110, T130.
  - T110 fails because it proves A7.10's branch-only causes against the A8.1 branch.

## Proof

- Typecheck clean; `npm run test:a3:scope` passes; `npm run db:verify:replay` ALL CHECKS PASS.
- A throwaway local clone of this branch, committed, runs the full chain through `npm run test:harness-corrections:a8`.
- Two official `npm run test:harness-corrections:a8` runs at one HEAD, each a complete PASS, with their full nested
  outputs.

---

# A5.10 and A7.2 later-phase recognition (before CRG-01)

Branch `fix/a5-10-a7-2-harness-later-phase-recognition`, from `main` at `a9f1580` (A8.3 merge). It changes only
A5.10 T112, the A7.2 check of the migration replay script, this document, and a new acceptance suite with its one
package script. No product module, migration, schema, permission, audit action, route, frontend page or accepted
contract changes.

## Why

CRG-01 FINAL (Checkpoint A) adds the code-system identity `HCPCS-LEVEL-II`. DHA General Circular GC 06-2026 (clause
C1) mandates this code set for Dubai claims. CRG-01 also adds a table holding retirement classifications. Its clone
proof exposed two earlier checks that judge a later package by a name:

- **A5.10 T112 "No US runtime"** searches every production file at HEAD for US words (X12, clearinghouse, Medicare,
  Medicaid, HCPCS, NPI). On the CRG-01 branch it fails on the DHA code-set name. That failure cascades through every
  later chain (A6 → A7 → A8.3).
- **The replay check "the A7.2 tables are exactly source_evidence_classifications"** counts every replayed table whose
  name matches `classif|normaliz`. It would count CRG-01's `crg_retirement_classifications` as an A7.2 table.

The same two wrong fixes stay rejected:

- renaming CRG-01's table or identity to dodge the patterns;
- allowing one word in T112's list.

Neither is done.

## Changed predicates

| Check | Before | After | Own branch |
|---|---|---|---|
| A5.10 T112 no US runtime | the word list over every production file (`modules`, `shared`, `app.ts`, `server.ts`) at `HEAD` | the same word list over the production files at A5.10's own merge (`158c9b7`), found with `mergeOf(feature/a5-10-a5-integration-acceptance)` against `origin/main`; if the merge is not found it stays on `HEAD` | unchanged (`ownMerge = ''`, so `HEAD`) |
| Replay script, A7.2 tables | replayed tables whose name matches `classif\|normaliz` equal `[source_evidence_classifications]` | the tables the A7.2 migration file itself creates equal `[source_evidence_classifications]`, and each exists after the clean replay, exactly as the A8.1 check | the PASS text is unchanged |

T110 and T113 of A5.10 are unchanged. They still judge HEAD, and a later package that sets a market switch or a UAE
literal still fails them. The word list of T112 is unchanged. A later package proves its own boundaries: CRG-01 checks
its own module for US runtime terms.

## Acceptance of this correction (`npm run test:harness-corrections:a5-a7`)

Run on any branch but its own, A8.3 always fails its checks about its own branch. So the final gate for this branch is
`backend/src/integration/harness-corrections-a5-a7`. Every check is executed. Nothing is N/A except the nested A8.3
branch-only items, each proved for its cause.

- **H01–H05 scope:**
  - branch from the main that contains the A8.3 and A5.10 merges;
  - clean tree and origin parity;
  - exactly the five changed files;
  - no module, shared, job, app, server, prisma or frontend change, and the replay script changed only in its A7.2
    check;
  - `package.json` differs only by this suite's script;
  - every contract constant identical to main.
- **H06–H08 every check kept:**
  - the A5.10 suite has exactly its check ids and titles from main;
  - its N/A map and every N/A call are byte-identical;
  - every changed line is a T112 own-scope definition or use, a comment, a line the original already had, or the
    replay's A7.2 table check.
- **H09–H12 equivalence and refusal:**
  - T112 is defined once from `ownMerge`, and with `''` it is literally the original;
  - a later package naming `HCPCS-LEVEL-II` fails the original predicate (fix disabled → FAIL) and is not judged by
    the corrected one;
  - an X12 term in A5.10's own merged code still fails both;
  - at this HEAD the original HEAD-wide predicate also PASSes, so nothing that exists today is hidden;
  - the replay passes with the unchanged PASS text, and at this HEAD no other committed migration creates a table
    named like A7.2's.
- **H13–H17 full chain:**
  - A8.3 → A8.2 → A8.1 → A7.10 → … → A5.10 → … → A1 run once;
  - every A8.3 substantive check PASSes, including T111–T118 and the gates T121 and T125–T129;
  - no nested A5.10 T112 or A7.2 replay-table failure appears anywhere;
  - each A8.3 branch-only failure is proved for its own cause on this branch, all the way down to A7.9.
- **H18:** exact HEAD equal to origin, clean tree, and the full nested output kept in `backend/hc57-nested-<run>.log`.

## What remains branch-only

These checks are unchanged. They are documented as branch-only N/A in a later package's nested chain:

- A8.3 in a later chain: T001, T002, T010, T119, T130.

## Proof

- Typecheck clean; `npm run test:a3:scope` passes; `npm run db:verify:replay` ALL CHECKS PASS.
- A throwaway local clone of this branch, committed, runs the full chain through
  `npm run test:harness-corrections:a5-a7`.
- Two official `npm run test:harness-corrections:a5-a7` runs at one HEAD, each a complete PASS, with their full
  nested outputs.

---

# A7.2–A7.5 later-phase table recognition (bundled in CRG-01)

This correction ships inside the CRG-01 FINAL (Checkpoint A) PR on branch `fix/crg-01-final-coding-release`, by the
head developer's decision. It is not a separate PR, which saves one review cycle. It is disclosed here and in the PR
description. It changes only four A7 suites, two code lines each. No product module, migration, schema, permission,
route or accepted contract of A7 changes.

## Why

CRG-01 adds the table `crg_release_imports`. It holds the import record of a coding catalogue edition: source file
SHA-256 and row count. Four accepted A7 suites refuse any live table whose name matches a later-domain pattern
containing `import`. That word was meant for an A9 payer or remittance import. On the CRG-01 branch these suites judge
CRG-01's table by its name:

| Suite | Check | Pattern |
|---|---|---|
| A7.2 `a7-evidence-classification` | T026 no imported payer source fabricated | `payer_response\|remittance\|import\|inbound\|adjudicat` |
| A7.3 `a7-evidence-gate` | T105 no A7.4+ or A9 domain | `adjudicat\|denial\|allowed\|remittance\|settle\|import\|inbound\|outbox\|queue\|transmission\|acknowledg` |
| A7.4 `a7-evidence-case` | T107 no A7.5 or A9 work | the A7.3 pattern plus `closure` |
| A7.5 `a7-case-prerequisite` | T108 no A7.6–A9 or payer integration | the A7.4 pattern plus `reconcil\|payer_response` |

The same wrong fixes stay rejected:

- renaming `crg_release_imports` to dodge the pattern;
- marking the checks N/A.

Neither is done.

## Changed predicates

In each suite the pattern and the rest of the check are unchanged. The live tables matching the pattern are reduced
by the tables created by migrations committed after that suite's own merge. The set comes from git: the migration
directories at `HEAD` that are absent at the suite's own merge, and the `CREATE TABLE` statements in their committed
files. It is never read from the database or from a name. This is exactly the accepted A6.10 T110 rule (first
correction) and the A8.1 T100/T119 rule.

On the suite's own branch `ownMerge = ''`, so the set is empty and the predicate is literally the original. Every table
that existed when the suite merged is still judged by the original name boundary. A table that no committed
migration creates, for example one created by hand, is never excluded.

A later package proves its own domain. CRG-01 has no payer, remittance, adjudication or import-of-payer-data route or
table. Its own harness proves this in CRG-003 and CRG-009.

## Acceptance

There is no separate suite. The CRG-01 harness is the gate:

- **CRG-003** proves the change is exactly bounded. In each of the four suites, over this package's own range, the
  only changed code lines are the later-phase table set (byte-identical to the A8.1 definition) and the original
  query with `.filter((t) => !laterPhaseTables.has(t))` appended. Every other changed line is a comment.
- **CRG-123 and CRG-124** run the full A8.3 → A1 chain. A7.2 T026, A7.3 T105, A7.4 T107 and A7.5 T108 PASS inside
  it. Every documented branch-only item is proved for its cause, all the way down.
- **CRG-G08** reviews the correction in every run. For each of the four suites it shows:
  - the pattern is byte-identical to its accepted one;
  - on the suite's own branch nothing is excluded;
  - at the tested HEAD the only live table excluded is `crg_release_imports`, created by CRG-01's own migration, and
    no other matching table goes unjudged;
  - a hand-made `remittance_import_probe_*` table with no migration (rolled back) is still refused by all four.
- Two official CRG-01 runs at one HEAD are the evidence.
