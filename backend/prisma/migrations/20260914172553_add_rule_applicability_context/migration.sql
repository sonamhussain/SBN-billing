-- CreateTable
CREATE TABLE "rule_applicabilities" (
    "id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "payer_id" UUID,
    "tpa_id" UUID,
    "network_id" UUID,
    "service_id" UUID,
    "procedure_code_id" UUID,
    "diagnosis_code_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_applicabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_applicabilities_rule_version_id_idx" ON "rule_applicabilities"("rule_version_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_payer_id_idx" ON "rule_applicabilities"("payer_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_tpa_id_idx" ON "rule_applicabilities"("tpa_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_network_id_idx" ON "rule_applicabilities"("network_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_service_id_idx" ON "rule_applicabilities"("service_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_procedure_code_id_idx" ON "rule_applicabilities"("procedure_code_id");

-- CreateIndex
CREATE INDEX "rule_applicabilities_diagnosis_code_id_idx" ON "rule_applicabilities"("diagnosis_code_id");

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_procedure_code_id_fkey" FOREIGN KEY ("procedure_code_id") REFERENCES "procedure_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_applicabilities" ADD CONSTRAINT "rule_applicabilities_diagnosis_code_id_fkey" FOREIGN KEY ("diagnosis_code_id") REFERENCES "diagnosis_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exact-scope uniqueness: NULLS NOT DISTINCT prevents duplicate broad/partially-null
-- applicability branches for the same RuleVersion (A3.6 duplicate-row protection).
CREATE UNIQUE INDEX "rule_applicabilities_exact_scope_uq"
ON "rule_applicabilities" (
  rule_version_id,
  payer_id,
  tpa_id,
  network_id,
  service_id,
  procedure_code_id,
  diagnosis_code_id
)
NULLS NOT DISTINCT;
