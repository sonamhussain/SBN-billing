-- A4.4 — Encounter: one patient service event with server-resolved provider/regulatory context.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. This migration creates exactly one table; no A1–A4.3 table is altered, and no
-- applied migration is rewritten.

-- CreateTable
CREATE TABLE "encounters" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "clinician_id" UUID NOT NULL,
    "insurance_membership_id" UUID,
    "service_date" DATE NOT NULL,
    "clinician_facility_assignment_id" UUID NOT NULL,
    "facility_regulatory_profile_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "encounters_patient_id_idx" ON "encounters"("patient_id");

-- CreateIndex
CREATE INDEX "encounters_facility_id_idx" ON "encounters"("facility_id");

-- CreateIndex
CREATE INDEX "encounters_clinician_id_idx" ON "encounters"("clinician_id");

-- CreateIndex
CREATE INDEX "encounters_insurance_membership_id_idx" ON "encounters"("insurance_membership_id");

-- CreateIndex
CREATE INDEX "encounters_service_date_idx" ON "encounters"("service_date");

-- AddForeignKey: an Encounter is clinical-event history, so no referenced patient, master or
-- context row can be deleted out from under it.
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "clinicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_insurance_membership_id_fkey" FOREIGN KEY ("insurance_membership_id") REFERENCES "insurance_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_clinician_facility_assignment_id_fkey" FOREIGN KEY ("clinician_facility_assignment_id") REFERENCES "clinician_facility_assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_facility_regulatory_profile_id_fkey" FOREIGN KEY ("facility_regulatory_profile_id") REFERENCES "facility_regulatory_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- There is deliberately NO UNIQUE on (patient_id, service_date) or (clinician_id, facility_id,
-- service_date): several legitimate encounters may share them. There is no organization_id,
-- status, eligibility, authorization, claim, price, diagnosis, activity, specialty or external
-- visit ID column. clinician_facility_assignment_id and facility_regulatory_profile_id are written
-- only by the server from the A4.2 and A3 resolvers.
