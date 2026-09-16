-- DropIndex
-- Replaced below with a 12-dimension NULLS NOT DISTINCT index covering the full V2 context
-- (REF-01 / R5). The old 6-dimension index has no schema-DSL representation, which is also
-- why Prisma's diff engine proposes dropping the unrelated rule_source_scopes_exact_scope_uq
-- index every time — that drop is migration drift and is intentionally NOT applied here.
DROP INDEX "rule_applicabilities_exact_scope_uq";

-- AlterTable
ALTER TABLE "rule_applicabilities" ADD COLUMN     "facility_id" UUID,
ADD COLUMN     "facility_regulatory_profile_id" UUID,
ADD COLUMN     "insurance_product_id" UUID,
ADD COLUMN     "provider_contract_id" UUID,
ADD COLUMN     "tariff_schedule_id" UUID,
ADD COLUMN     "tariff_schedule_version_id" UUID;

-- CreateIndex
CREATE INDEX "rule_applicabilities_facility_id_idx" ON "rule_applicabilities"("facility_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_facility_regulatory_profile_id_idx" ON "rule_applicabilities"("facility_regulatory_profile_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_insurance_product_id_idx" ON "rule_applicabilities"("insurance_product_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_provider_contract_id_idx" ON "rule_applicabilities"("provider_contract_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_tariff_schedule_id_idx" ON "rule_applicabilities"("tariff_schedule_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_tariff_schedule_version_id_idx" ON "rule_applicabilities"("tariff_schedule_version_id");

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_facility_regulatory_profile_id_fkey" FOREIGN KEY ("facility_regulatory_profile_id") REFERENCES "facility_regulatory_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_provider_contract_id_fkey" FOREIGN KEY ("provider_contract_id") REFERENCES "provider_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_tariff_schedule_id_fkey" FOREIGN KEY ("tariff_schedule_id") REFERENCES "tariff_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_tariff_schedule_version_id_fkey" FOREIGN KEY ("tariff_schedule_version_id") REFERENCES "tariff_schedule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exact-scope uniqueness recreated over all twelve V2 dimensions — the old six-dimension index
-- must not remain as the only uniqueness guard (REF-01 / R5). NULLS NOT DISTINCT still prevents
-- duplicate broad/partially-null applicability branches for the same RuleVersion.
CREATE UNIQUE INDEX "rule_applicabilities_exact_scope_uq"
ON "rule_applicabilities" (
  rule_version_id,
  facility_id,
  facility_regulatory_profile_id,
  payer_id,
  tpa_id,
  network_id,
  insurance_product_id,
  provider_contract_id,
  tariff_schedule_id,
  tariff_schedule_version_id,
  service_id,
  procedure_code_id,
  diagnosis_code_id
)
NULLS NOT DISTINCT;
