# Harness Corrections — Later-Phase Recognition (before A8.1)

Branch `fix/a6-a7-harness-later-phase-recognition`, from `main` at `0a74f47` (A7.10 merge). Harness files only: no
product module, migration, schema, permission, audit action, route, frontend page or accepted contract changes.

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

## What remains branch-only

These checks are unchanged and are still documented as branch-only N/A in a later package's nested chain. They prove
the package's own branch, ancestry, head, changed-file scope or acceptance register, and the parent proves its own:

- A6.10: T001, T004, T007, T010, T120, T130.
- A7.10 in the A8.1 chain: T001, T002, T010, T111, T122, T123, T130.

## Proof

- Typecheck clean; `npm run test:a3:scope` passes.
- A throwaway local clone of this branch, committed, runs A6.10 and every A7 suite **fully**, each with only its own
  nested chain stubbed. Each suite's failures are exactly its documented branch-only items.
- Two official `npm run test:a7:phase-closure` runs on this branch, where only the documented branch-only items of
  the top-level A7.10 run itself fail, because this branch is not A7.10's own branch.
