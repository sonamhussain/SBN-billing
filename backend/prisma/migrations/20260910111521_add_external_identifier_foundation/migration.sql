-- AlterTable
ALTER TABLE "account" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "session" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "verification" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- CreateTable
CREATE TABLE "external_identifiers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_system" TEXT NOT NULL,
    "external_value" TEXT NOT NULL,
    "organization_target_id" UUID,
    "facility_id" UUID,
    "clinician_id" UUID,
    "specialty_id" UUID,
    "payer_id" UUID,
    "tpa_id" UUID,
    "network_id" UUID,
    "service_id" UUID,
    "procedure_code_id" UUID,
    "diagnosis_code_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_identifiers_organization_id_idx" ON "external_identifiers"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identifiers_organization_id_source_system_external_key" ON "external_identifiers"("organization_id", "source_system", "external_value");

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_organization_target_id_fkey" FOREIGN KEY ("organization_target_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "clinicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_specialty_id_fkey" FOREIGN KEY ("specialty_id") REFERENCES "specialties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_procedure_code_id_fkey" FOREIGN KEY ("procedure_code_id") REFERENCES "procedure_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identifiers" ADD CONSTRAINT "external_identifiers_diagnosis_code_id_fkey" FOREIGN KEY ("diagnosis_code_id") REFERENCES "diagnosis_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: exactly one target FK must be non-null (A2.9 hard gate)
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
    "diagnosis_code_id"
  ) = 1
);
