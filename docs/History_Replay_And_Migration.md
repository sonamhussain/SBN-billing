# History, replay and migration — what the evidence can and cannot prove

Audit F12. This document fixes three distinctions that were previously only implied by code
comments. It is the contract; a comment that disagrees with this document is wrong.

## 1. A3.8 is an as-of-effective-date resolver, not a record of what the system knew

A3.8 resolves precedence by recomputing against **today's stored governance facts** for a
requested `businessDate`. It answers:

> Given everything the system holds right now, which governing source wins for this business date?

It does **not** answer:

> What did the system conclude when this decision was originally made?

The two differ whenever the stored facts change after an evaluation. Appending a new
`RuleSourceBinding`, a new `RuleSourceScope`, or a new `CONFLICTS_WITH` edge changes a later
recomputation for the same `businessDate`, even though every identifier from the original
evaluation still exists and still resolves. The old IDs surviving is not evidence that the old
answer survives.

Consequences that are binding on later packages:

- **A3.8 / A3.9** must never be described as historical replay, an audit trail of decisions, or
  proof of what was known at an earlier time. `businessDate` selects the effective date to resolve
  *as of*, not the knowledge state to resolve *from*.
- **A5 / A6** (real decisions and submissions) must **freeze** the authoritative result at the
  moment the decision occurs: the outcome, the full evaluation context, the exact version
  identifiers used, and the identity of the policy that produced it. They must store that frozen
  record and read it back when the decision is later inspected.
- A5 / A6 must **not** replace a recorded outcome by calling the resolver again. A fresh resolver
  call is a new recomputation, not a retrieval of the recorded decision. Re-running it to "check"
  an old decision compares two different questions.
- No "as known at timestamp T" store exists today. If one is ever needed, it is a separate,
  explicitly designed domain store — not something to be inferred from current tables.

## 2. Dataset lifecycle history: bounded, append-only, and starting from F12

`ReferenceDatasetLifecycleEvent` records **successful** validate / activate / supersede / retire /
rollback transitions of reference dataset versions. It exists because retaining every dataset
*version* is not the same as retaining every *transition*: re-activating a superseded version
overwrites its `activatedAt`, and superseding it again overwrites its `supersededAt`, so a
`v1 → v2 → v1 → v2` chain cannot be recovered from the current rows.

What it is:

- One row per successful transition, written in the **same transaction** as the state change.
- Dataset id, dataset version id, action, previous and next activation status, previous and next
  validation status, a server timestamp, a monotonic `sequence`, the trusted maintenance actor,
  and an optional reason.
- **Append-only**, enforced by a database trigger: `UPDATE` and `DELETE` are both rejected.

What it is deliberately **not**:

- Not a universal audit framework, a `RuleDecision` table, or a workflow engine.
- Not a tenant audit record. Reference datasets are `SYSTEM_SHARED` and carry no
  `organizationId`, and none is invented to force them into `AuditEvent`.
- Not backfilled. Transitions that happened before this table existed have no evidence, and no
  event or timestamp is fabricated for them. **Dataset history starts at migration
  `20260917184029_f12_reference_dataset_lifecycle_events`**, and a reader can tell the difference
  by comparing an event's `sequence` against that migration's application time.
- Not a record of attempts. A refused operation writes nothing; the history says what happened.

Proof: `npm run test:a3:history` (C33) walks `v1 → v2 → v1 → v2`, shows the current rows cannot
distinguish that chain from a single move, replays the recorded events from scratch to reproduce
the stored state exactly, and confirms the database refuses to alter or delete a recorded event.

## 3. Migrations: clean replay and populated intermediate databases are different claims

Applied migrations are **immutable**. A defect in an applied migration is corrected by a new
forward migration, never by editing or re-ordering an existing one, and never by
`prisma migrate reset` on a database that holds data.

Two separate claims have to be proven separately:

1. **Clean replay** — every migration applies, in order, into an empty database and produces the
   intended schema.
2. **Populated upgrade** — a database that already holds rows reaches that same schema by applying
   only the migrations it has not yet applied, without data loss and without guessed backfill.

Neither implies the other, and an earlier REF-01 correction migration that adds required contract
fields and changes dataset status vocabulary must **not** be described as universally safe for a
populated intermediate state on the strength of a clean-replay run alone.

`npm run db:verify:replay` proves both at once. It replays every migration into a brand-new
database, then compares that schema to the working database — which reached the same point by
upgrading in place, with rows present — across every column, constraint, index and trigger. It
only reads the working database, and it drops its own scratch database afterwards.

### Standing rules for new migrations

- **Read-only inventory first.** Before adding any constraint, count the rows that would violate
  it. If any exist, stop and hand back the exact affected IDs for a controlled decision. Never
  pick "the newest", "the highest version" or "the latest timestamp" as the correct history, and
  never hard-delete a conflicting row.
- **Backfill only from real evidence.** A column that records a historical fact is populated only
  where the database already proves that fact. Where it does not, the column stays null or false;
  no time is invented.
- **Migration Drift Guard.** Prisma's generated SQL repeatedly re-emits four auth-table
  `ALTER COLUMN "id" SET DEFAULT` lines and `DROP INDEX` statements for hand-written objects its
  DSL cannot represent. Those must be removed from every generated migration before it is applied.
  The hand-written objects to protect are:
  - `rule_applicabilities_exact_scope_uq` (`NULLS NOT DISTINCT`)
  - `rule_source_scopes_exact_scope_uq` (`NULLS NOT DISTINCT`)
  - `reference_dataset_versions_one_active_uq` (partial unique index, F11)
  - `reference_dataset_lifecycle_events_append_only_trg` (append-only trigger, F12)

  `npm run db:verify:replay` fails if any of them is lost.
