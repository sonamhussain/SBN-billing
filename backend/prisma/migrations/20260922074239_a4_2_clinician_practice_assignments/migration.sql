-- A4.2 — effective-dated Clinician↔Facility and Clinician↔Specialty practice assignments.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. This migration creates exactly the two assignment tables; no A1–A4.1 table is
-- altered, Patient and ExternalIdentifier are untouched, and no applied migration is rewritten.

-- CreateTable
CREATE TABLE "clinician_facility_assignments" (
    "id" UUID NOT NULL,
    "clinician_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    -- Calendar dates, never timestamps. effective_to NULL means the assignment is still open.
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinician_facility_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinician_specialty_assignments" (
    "id" UUID NOT NULL,
    "clinician_id" UUID NOT NULL,
    "specialty_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "clinician_specialty_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clinician_facility_assignments_clinician_id_idx" ON "clinician_facility_assignments"("clinician_id");

-- CreateIndex
CREATE INDEX "clinician_facility_assignments_facility_id_idx" ON "clinician_facility_assignments"("facility_id");

-- CreateIndex
CREATE INDEX "clinician_facility_assignments_clinician_id_facility_id_idx" ON "clinician_facility_assignments"("clinician_id", "facility_id");

-- CreateIndex
CREATE INDEX "clinician_specialty_assignments_clinician_id_idx" ON "clinician_specialty_assignments"("clinician_id");

-- CreateIndex
CREATE INDEX "clinician_specialty_assignments_specialty_id_idx" ON "clinician_specialty_assignments"("specialty_id");

-- CreateIndex
CREATE INDEX "clinician_specialty_assignments_clinician_id_specialty_id_idx" ON "clinician_specialty_assignments"("clinician_id", "specialty_id");

-- AddForeignKey: a master that an assignment still refers to cannot be deleted out from under it.
ALTER TABLE "clinician_facility_assignments" ADD CONSTRAINT "clinician_facility_assignments_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "clinicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinician_facility_assignments" ADD CONSTRAINT "clinician_facility_assignments_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinician_specialty_assignments" ADD CONSTRAINT "clinician_specialty_assignments_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "clinicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinician_specialty_assignments" ADD CONSTRAINT "clinician_specialty_assignments_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECKs: a closed period may not end before it starts. A single-day period
-- (effective_to = effective_from) is valid, and an open period leaves effective_to NULL.
ALTER TABLE "clinician_facility_assignments"
  ADD CONSTRAINT "clinician_facility_assignments_effective_period_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

ALTER TABLE "clinician_specialty_assignments"
  ADD CONSTRAINT "clinician_specialty_assignments_effective_period_chk" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- There is deliberately NO UNIQUE(clinician_id, target_id): the same pair may hold several
-- non-overlapping periods over time. Overlap for one exact pair is refused by the service, which
-- locks the clinician row before it checks, so concurrent writers serialize. No btree_gist
-- exclusion constraint is introduced unless a later audit proves that lock insufficient.
