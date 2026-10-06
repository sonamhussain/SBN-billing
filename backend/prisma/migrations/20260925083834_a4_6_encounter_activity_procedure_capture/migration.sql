-- A4.6 — EncounterActivity: immutable service/procedure activity facts under an Encounter, with
-- exact Decimal quantity, an optional opaque unit code and ordered opaque modifier codes.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. The A4.5 partial indexes (encounter_diagnoses_active_code_uidx,
-- encounter_diagnoses_active_sequence_uidx) are untouched. This migration creates exactly two
-- tables; no A1–A4.5 table is altered, and no applied migration is rewritten.

-- CreateTable
CREATE TABLE "encounter_activities" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "service_id" UUID,
    "procedure_code_id" UUID,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_code" TEXT,
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_activity_modifiers" (
    "id" UUID NOT NULL,
    "encounter_activity_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encounter_activity_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_activities_encounter_id_idx" ON "encounter_activities"("encounter_id");

-- CreateIndex
CREATE INDEX "encounter_activities_service_id_idx" ON "encounter_activities"("service_id");

-- CreateIndex
CREATE INDEX "encounter_activities_procedure_code_id_idx" ON "encounter_activities"("procedure_code_id");

-- CreateIndex
CREATE INDEX "encounter_activities_encounter_id_removed_at_idx" ON "encounter_activities"("encounter_id", "removed_at");

-- CreateIndex
CREATE INDEX "encounter_activity_modifiers_encounter_activity_id_idx" ON "encounter_activity_modifiers"("encounter_activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_activity_modifiers_encounter_activity_id_sequence_key" ON "encounter_activity_modifiers"("encounter_activity_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "encounter_activity_modifiers_encounter_activity_id_code_key" ON "encounter_activity_modifiers"("encounter_activity_id", "code");

-- AddForeignKey
ALTER TABLE "encounter_activities" ADD CONSTRAINT "encounter_activities_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_activities" ADD CONSTRAINT "encounter_activities_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_activities" ADD CONSTRAINT "encounter_activities_procedure_code_id_fkey" FOREIGN KEY ("procedure_code_id") REFERENCES "procedure_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_activity_modifiers" ADD CONSTRAINT "encounter_activity_modifiers_encounter_activity_id_fkey" FOREIGN KEY ("encounter_activity_id") REFERENCES "encounter_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written integrity (A4.6 §11) -------------------------------------------------------------

-- An activity names a Service, a ProcedureCode or both — never neither. No Service<->Procedure
-- mapping is asserted when both are present.
ALTER TABLE "encounter_activities"
  ADD CONSTRAINT "encounter_activities_identity_chk" CHECK (num_nonnulls("service_id", "procedure_code_id") >= 1);

-- Quantity is an exact, strictly positive NUMERIC.
ALTER TABLE "encounter_activities"
  ADD CONSTRAINT "encounter_activities_quantity_positive_chk" CHECK ("quantity" > 0);

-- The optional unit code is opaque (no vocabulary) but never blank.
ALTER TABLE "encounter_activities"
  ADD CONSTRAINT "encounter_activities_unit_code_nonblank_chk" CHECK ("unit_code" IS NULL OR btrim("unit_code") <> '');

-- A modifier position is always 1-based.
ALTER TABLE "encounter_activity_modifiers"
  ADD CONSTRAINT "encounter_activity_modifiers_sequence_positive_chk" CHECK ("sequence" >= 1);

-- A modifier code is opaque (no vocabulary) but never blank.
ALTER TABLE "encounter_activity_modifiers"
  ADD CONSTRAINT "encounter_activity_modifiers_code_nonblank_chk" CHECK (btrim("code") <> '');

-- There is deliberately no UNIQUE over Service/Procedure combinations (repeated activities are
-- legitimate), and no organization_id, patient/context copy, code/name snapshot, sequence or line
-- number, diagnosis pointer, price, amount or tariff column.
