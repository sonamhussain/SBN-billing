-- Audit F09 — a failed resume must not unlock previously governed effective dates.
--
-- ACTIVE -> SUSPENDED -> failed resume writes activation_status = 'BLOCKED' and, because
-- rule_source_versions_blocked_chk requires it, activated_at = NULL. The date freeze was derived
-- from the CURRENT status only, so that previously activated version became editable again.
-- activated_at therefore cannot carry the historical fact; this migration adds an explicit
-- durable marker (the fact) plus the original activation evidence (the timestamp).
--
-- Migration Drift Guard applied to the generated SQL: the four recurring auth-table
-- "ALTER COLUMN id SET DEFAULT" lines and the two spurious DROP INDEX statements for the
-- hand-written NULLS NOT DISTINCT indexes (rule_applicabilities_exact_scope_uq,
-- rule_source_scopes_exact_scope_uq — Prisma's DSL cannot represent them) were removed.

ALTER TABLE "rule_source_versions"
  ADD COLUMN "ever_activated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "first_activated_at" TIMESTAMPTZ(6);

-- Backfill from actual evidence only; no historical time is invented.
--   activated_at IS NOT NULL  -> the row is, or once was, ACTIVE (suspend/supersede/retire keep it)
--   suspended_at IS NOT NULL  -> suspend is only reachable from ACTIVE
-- A BLOCKED row with neither is a failed FIRST activation and was never governing, and a
-- SUPERSEDED row with neither was superseded while still INACTIVE.
UPDATE "rule_source_versions"
SET "ever_activated" = true,
    "first_activated_at" = "activated_at"
WHERE "activated_at" IS NOT NULL OR "suspended_at" IS NOT NULL;

-- Evidence cannot exist without the fact.
ALTER TABLE "rule_source_versions"
  ADD CONSTRAINT "rule_source_versions_first_activated_chk"
  CHECK ("first_activated_at" IS NULL OR "ever_activated");

-- Being ACTIVE implies the fact.
ALTER TABLE "rule_source_versions"
  ADD CONSTRAINT "rule_source_versions_active_implies_ever_chk"
  CHECK ("activation_status" <> 'ACTIVE' OR "ever_activated");
