-- Audit F11 — reference dataset state invariants, enforced in the database.
--
-- Two invariants were held only by application code, and only at the moment of the call:
--   1. ACTIVE implies VALIDATED. activateReferenceDatasetVersion checked validation at
--      activation, but validateReferenceDatasetVersion could later downgrade that same ACTIVE
--      row to UNVALIDATED or REJECTED without touching activation_status.
--   2. At most one ACTIVE version per dataset. The supersede-then-activate pair ran in a default
--      (READ COMMITTED) transaction with no parent lock, so two concurrent FIRST activations
--      could both read "no active sibling" and both commit ACTIVE.
-- The service now serializes validate/activate/retire on the parent reference_datasets row; these
-- are the final backstop, not a substitute for that transaction and its sanitized typed error.
--
-- Read-only inventory taken before writing this migration (required before new guards):
--   19 datasets, 71 dataset versions.
--   Datasets with more than one ACTIVE version: 0 rows.
--   ACTIVE rows whose validation_status is not VALIDATED: 0 rows.
--   Status pairs present: INACTIVE/REJECTED 5, INACTIVE/UNVALIDATED 56, RETIRED/VALIDATED 5,
--   SUPERSEDED/VALIDATED 5.
-- No conflicting row exists, so nothing is remediated, rewritten or deleted here and no history
-- is guessed. Had any conflict existed, this migration would not have been written: the exact
-- affected IDs would have gone back for a controlled decision instead.
--
-- Migration Drift Guard applied to the generated SQL: the four recurring auth-table
-- "ALTER COLUMN id SET DEFAULT" lines and the two spurious DROP INDEX statements for the
-- hand-written NULLS NOT DISTINCT indexes (rule_applicabilities_exact_scope_uq,
-- rule_source_scopes_exact_scope_uq — Prisma's DSL cannot represent them) were removed.

-- An in-force dataset version must be validated. A controlled invalidation has to withdraw the
-- active state first (retire it, or activate another VALIDATED version), which keeps the history.
ALTER TABLE "reference_dataset_versions"
  ADD CONSTRAINT "reference_dataset_versions_active_implies_validated_chk"
  CHECK ("activation_status" <> 'ACTIVE' OR "validation_status" = 'VALIDATED');

-- At most one ACTIVE version per dataset. A partial unique index cannot be expressed in Prisma's
-- DSL, so it is written by hand here and must be preserved by the Migration Drift Guard in every
-- later migration, exactly like the two NULLS NOT DISTINCT indexes above.
CREATE UNIQUE INDEX "reference_dataset_versions_one_active_uq"
  ON "reference_dataset_versions" ("dataset_id")
  WHERE "activation_status" = 'ACTIVE';
