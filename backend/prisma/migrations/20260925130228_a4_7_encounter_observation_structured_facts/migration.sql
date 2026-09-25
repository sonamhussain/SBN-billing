-- A4.7 — EncounterObservation: typed, non-executable structured billing facts at Encounter scope or
-- at the scope of one EncounterActivity of the same Encounter.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. The A4.5 partial indexes and the A4.6 activity/modifier constraints are
-- untouched. This migration creates exactly one table; no A1–A4.6 table is altered, and no
-- applied migration is rewritten.

-- CreateTable
CREATE TABLE "encounter_observations" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "encounter_activity_id" UUID,
    "fact_key" TEXT NOT NULL,
    "value_type" TEXT NOT NULL,
    "value_text" TEXT,
    "value_decimal" DECIMAL(24,8),
    "value_boolean" BOOLEAN,
    "value_date" DATE,
    "unit_code" TEXT,
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_observations_encounter_id_idx" ON "encounter_observations"("encounter_id");

-- CreateIndex
CREATE INDEX "encounter_observations_encounter_activity_id_idx" ON "encounter_observations"("encounter_activity_id");

-- CreateIndex
CREATE INDEX "encounter_observations_encounter_id_removed_at_idx" ON "encounter_observations"("encounter_id", "removed_at");

-- CreateIndex
CREATE INDEX "encounter_observations_fact_key_idx" ON "encounter_observations"("fact_key");

-- AddForeignKey
ALTER TABLE "encounter_observations" ADD CONSTRAINT "encounter_observations_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_observations" ADD CONSTRAINT "encounter_observations_encounter_activity_id_fkey" FOREIGN KEY ("encounter_activity_id") REFERENCES "encounter_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written integrity (A4.7 §8) --------------------------------------------------------------

-- The fact key is opaque (no vocabulary) but never blank.
ALTER TABLE "encounter_observations"
  ADD CONSTRAINT "encounter_observations_fact_key_nonblank_chk" CHECK (btrim("fact_key") <> '');

-- Exactly the four approved value types; there is no CODE, JSON, list or expression type.
ALTER TABLE "encounter_observations"
  ADD CONSTRAINT "encounter_observations_value_type_chk" CHECK ("value_type" IN ('TEXT', 'DECIMAL', 'BOOLEAN', 'DATE'));

-- A text value is never blank.
ALTER TABLE "encounter_observations"
  ADD CONSTRAINT "encounter_observations_text_nonblank_chk" CHECK ("value_text" IS NULL OR btrim("value_text") <> '');

-- An opaque unit is never blank.
ALTER TABLE "encounter_observations"
  ADD CONSTRAINT "encounter_observations_unit_nonblank_chk" CHECK ("unit_code" IS NULL OR btrim("unit_code") <> '');

-- Exactly the typed column that matches value_type is populated; a unit only accompanies DECIMAL.
ALTER TABLE "encounter_observations"
  ADD CONSTRAINT "encounter_observations_typed_value_chk" CHECK (
    ("value_type" = 'TEXT'
      AND "value_text" IS NOT NULL
      AND "value_decimal" IS NULL AND "value_boolean" IS NULL AND "value_date" IS NULL
      AND "unit_code" IS NULL)
    OR
    ("value_type" = 'DECIMAL'
      AND "value_text" IS NULL
      AND "value_decimal" IS NOT NULL
      AND "value_boolean" IS NULL AND "value_date" IS NULL)
    OR
    ("value_type" = 'BOOLEAN'
      AND "value_text" IS NULL AND "value_decimal" IS NULL
      AND "value_boolean" IS NOT NULL
      AND "value_date" IS NULL AND "unit_code" IS NULL)
    OR
    ("value_type" = 'DATE'
      AND "value_text" IS NULL AND "value_decimal" IS NULL AND "value_boolean" IS NULL
      AND "value_date" IS NOT NULL AND "unit_code" IS NULL)
  );

-- There is deliberately no UNIQUE on fact_key (repeated facts are legitimate), no JSON/JSONB
-- column, no operator/expression/condition/action/formula column, and no organization_id,
-- patient/provider/payer context, evidence, eligibility, authorization, claim or pricing column.
