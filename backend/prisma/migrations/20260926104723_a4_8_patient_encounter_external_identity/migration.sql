-- A4.8 — Patient & Encounter External Identity Extension.
--
-- This is an ADDITIVE extension of the canonical A2.9 ExternalIdentifier domain: two more typed
-- target columns, their RESTRICT foreign keys and indexes, and the exact-one-target CHECK widened
-- from 10 columns to 12 under its original name. Nothing is added to patients or encounters, and
-- the (organization_id, source_system, external_value) uniqueness is deliberately untouched.
--
-- Migration Drift Guard: Prisma also generated four Better Auth `ALTER COLUMN id SET DEFAULT`
-- statements and three `DROP INDEX` statements for the hand-written A3 partial unique indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). All seven are unrelated generated churn and were removed.

-- AlterTable
ALTER TABLE "external_identifiers" ADD COLUMN     "encounter_id" UUID,
ADD COLUMN     "patient_id" UUID;

-- CreateIndex
CREATE INDEX "external_identifiers_patient_id_idx" ON "external_identifiers"("patient_id");

-- CreateIndex
CREATE INDEX "external_identifiers_encounter_id_idx" ON "external_identifiers"("encounter_id");

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: exactly one target FK must be non-null. The A2.9 hard gate is replaced under its original
-- name so the invariant is never absent, and it now covers all 12 approved target columns. A row
-- with no target, or with two targets from any combination of old and new columns, is rejected by
-- the database itself rather than by application code.
ALTER TABLE "external_identifiers"
DROP CONSTRAINT "external_identifiers_exactly_one_target_chk";

ALTER TABLE "external_identifiers"
ADD CONSTRAINT "external_identifiers_exactly_one_target_chk"
CHECK (
  num_nonnulls(
    "organization_target_id",
    "facility_id",
    "clinician_id",
    "specialty_id",
    "payer_id",
    "tpa_id",
    "network_id",
    "service_id",
    "procedure_code_id",
    "diagnosis_code_id",
    "patient_id",
    "encounter_id"
  ) = 1
);
