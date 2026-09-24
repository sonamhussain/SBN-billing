-- A4.3 — patient-owned InsuranceMembership: recorded membership/coverage facts, NOT eligibility.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. This migration creates exactly one table; no A1–A4.2 table is altered, Patient
-- demographics and ExternalIdentifier are untouched, and no applied migration is rewritten.

-- CreateTable
CREATE TABLE "insurance_memberships" (
    "id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    -- TPA, network and product stay NULL when genuinely unknown; they are never guessed.
    "tpa_id" UUID,
    "network_id" UUID,
    "insurance_product_id" UUID,
    "member_identifier" TEXT NOT NULL,
    "policy_identifier" TEXT,
    -- Recorded calendar dates, never timestamps. NULL means an unknown recorded boundary.
    "coverage_from" DATE,
    "coverage_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "insurance_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "insurance_memberships_patient_id_idx" ON "insurance_memberships"("patient_id");

-- CreateIndex
CREATE INDEX "insurance_memberships_payer_id_idx" ON "insurance_memberships"("payer_id");

-- CreateIndex
CREATE INDEX "insurance_memberships_insurance_product_id_idx" ON "insurance_memberships"("insurance_product_id");

-- CreateIndex
CREATE INDEX "insurance_memberships_patient_id_coverage_from_idx" ON "insurance_memberships"("patient_id", "coverage_from");

-- AddForeignKey: a patient or commercial master that a membership still refers to cannot be
-- deleted out from under it, so membership history is never silently lost.
ALTER TABLE "insurance_memberships" ADD CONSTRAINT "insurance_memberships_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_memberships" ADD CONSTRAINT "insurance_memberships_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_memberships" ADD CONSTRAINT "insurance_memberships_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_memberships" ADD CONSTRAINT "insurance_memberships_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_memberships" ADD CONSTRAINT "insurance_memberships_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECK: when both recorded dates exist, the period may not end before it starts.
-- Either date may be unknown (NULL); an end date with no start date is a permitted recorded fact.
ALTER TABLE "insurance_memberships"
  ADD CONSTRAINT "insurance_memberships_coverage_period_chk" CHECK ("coverage_to" IS NULL OR "coverage_from" IS NULL OR "coverage_to" >= "coverage_from");

-- There is deliberately NO UNIQUE on member_identifier, policy_identifier, (patient_id, payer_id)
-- or any date combination: uniqueness semantics belong to payers and are not safely inferred, and
-- a patient may hold several — even overlapping — memberships. There is no organization_id,
-- status, eligibility, primary/rank, provider contract or tariff column.
