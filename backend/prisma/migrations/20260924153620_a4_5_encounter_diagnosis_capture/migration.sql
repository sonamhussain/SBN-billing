-- A4.5 — EncounterDiagnosis: the ordered, correctable link between an Encounter and A2.8
-- DiagnosisCode identities.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. This migration creates exactly one table; no A1–A4.4 table is altered, and no
-- applied migration is rewritten.
--
-- Future migrations: Prisma cannot express partial unique indexes, so later generated drafts will
-- also try to DROP encounter_diagnoses_active_code_uidx and encounter_diagnoses_active_sequence_uidx.
-- Those drops must be removed like the others; db:verify:replay fails if either index is lost.

-- CreateTable
CREATE TABLE "encounter_diagnoses" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "diagnosis_code_id" UUID NOT NULL,
    -- 1-based position among the Encounter's ACTIVE rows; written only by the server.
    "sequence" INTEGER NOT NULL,
    -- Set once on removal; the row is kept as correction history and never deleted.
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounter_diagnoses_encounter_id_idx" ON "encounter_diagnoses"("encounter_id");

-- CreateIndex
CREATE INDEX "encounter_diagnoses_diagnosis_code_id_idx" ON "encounter_diagnoses"("diagnosis_code_id");

-- CreateIndex
CREATE INDEX "encounter_diagnoses_encounter_id_removed_at_idx" ON "encounter_diagnoses"("encounter_id", "removed_at");

-- AddForeignKey: an encounter or diagnosis master that a diagnosis link still refers to cannot be
-- deleted out from under it, so correction history is never silently lost.
ALTER TABLE "encounter_diagnoses" ADD CONSTRAINT "encounter_diagnoses_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_diagnoses" ADD CONSTRAINT "encounter_diagnoses_diagnosis_code_id_fkey" FOREIGN KEY ("diagnosis_code_id") REFERENCES "diagnosis_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written integrity (A4.5 §8) --------------------------------------------------------------

-- A position is always 1-based.
ALTER TABLE "encounter_diagnoses"
  ADD CONSTRAINT "encounter_diagnoses_sequence_positive_chk" CHECK ("sequence" >= 1);

-- The same DiagnosisCode may be ACTIVE at most once per Encounter. Partial, so a removed
-- historical row never blocks legitimately adding that code again as a new row.
CREATE UNIQUE INDEX "encounter_diagnoses_active_code_uidx"
  ON "encounter_diagnoses" ("encounter_id", "diagnosis_code_id")
  WHERE "removed_at" IS NULL;

-- Two ACTIVE rows of one Encounter can never share a position. Partial for the same reason; the
-- service rewrites sequences in two phases so this index is never disabled during a reorder.
CREATE UNIQUE INDEX "encounter_diagnoses_active_sequence_uidx"
  ON "encounter_diagnoses" ("encounter_id", "sequence")
  WHERE "removed_at" IS NULL;

-- There is deliberately no organization_id, patient_id, code/display_name snapshot, is_primary,
-- role, status, claim, authorization or procedure column.
