-- CreateTable
CREATE TABLE "facility_regulatory_profiles" (
    "id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "regulatory_authority_code" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "facility_regulatory_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_products" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "product_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "insurance_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_networks" (
    "id" UUID NOT NULL,
    "insurance_product_id" UUID NOT NULL,
    "network_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_networks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_contracts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "insurance_product_id" UUID,
    "product_network_id" UUID,
    "contract_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_facilities" (
    "id" UUID NOT NULL,
    "provider_contract_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_facilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_schedules" (
    "id" UUID NOT NULL,
    "provider_contract_id" UUID NOT NULL,
    "tariff_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tariff_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_schedule_versions" (
    "id" UUID NOT NULL,
    "tariff_schedule_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "effective_from" DATE,
    "effective_to" DATE,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tariff_schedule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_datasets" (
    "id" UUID NOT NULL,
    "dataset_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "authority_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reference_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reference_dataset_versions" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "source_version_id" UUID,
    "version" TEXT NOT NULL,
    "retrieved_at" TIMESTAMPTZ(6) NOT NULL,
    "publication_date" DATE,
    "effective_from" DATE,
    "effective_to" DATE,
    "content_hash" TEXT NOT NULL,
    "validation_status" TEXT NOT NULL,
    "activation_status" TEXT NOT NULL,
    "activated_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reference_dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_source_scopes" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "facility_id" UUID,
    "payer_id" UUID,
    "tpa_id" UUID,
    "network_id" UUID,
    "insurance_product_id" UUID,
    "provider_contract_id" UUID,
    "tariff_schedule_id" UUID,
    "tariff_schedule_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_source_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facility_regulatory_profiles_facility_id_idx" ON "facility_regulatory_profiles"("facility_id");

-- CreateIndex
CREATE INDEX "facility_regulatory_profiles_status_idx" ON "facility_regulatory_profiles"("status");

-- CreateIndex
CREATE INDEX "insurance_products_organization_id_idx" ON "insurance_products"("organization_id");

-- CreateIndex
CREATE INDEX "insurance_products_payer_id_idx" ON "insurance_products"("payer_id");

-- CreateIndex
CREATE UNIQUE INDEX "insurance_products_organization_id_product_code_key" ON "insurance_products"("organization_id", "product_code");

-- CreateIndex
CREATE INDEX "product_networks_insurance_product_id_idx" ON "product_networks"("insurance_product_id");

-- CreateIndex
CREATE INDEX "product_networks_network_id_idx" ON "product_networks"("network_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_networks_insurance_product_id_network_id_key" ON "product_networks"("insurance_product_id", "network_id");

-- CreateIndex
CREATE INDEX "provider_contracts_organization_id_idx" ON "provider_contracts"("organization_id");

-- CreateIndex
CREATE INDEX "provider_contracts_insurance_product_id_idx" ON "provider_contracts"("insurance_product_id");

-- CreateIndex
CREATE INDEX "provider_contracts_product_network_id_idx" ON "provider_contracts"("product_network_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_contracts_organization_id_contract_key_key" ON "provider_contracts"("organization_id", "contract_key");

-- CreateIndex
CREATE INDEX "contract_facilities_provider_contract_id_idx" ON "contract_facilities"("provider_contract_id");

-- CreateIndex
CREATE INDEX "contract_facilities_facility_id_idx" ON "contract_facilities"("facility_id");

-- CreateIndex
CREATE UNIQUE INDEX "contract_facilities_provider_contract_id_facility_id_key" ON "contract_facilities"("provider_contract_id", "facility_id");

-- CreateIndex
CREATE INDEX "tariff_schedules_provider_contract_id_idx" ON "tariff_schedules"("provider_contract_id");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_schedules_provider_contract_id_tariff_key_key" ON "tariff_schedules"("provider_contract_id", "tariff_key");

-- CreateIndex
CREATE INDEX "tariff_schedule_versions_tariff_schedule_id_idx" ON "tariff_schedule_versions"("tariff_schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "tariff_schedule_versions_tariff_schedule_id_version_key" ON "tariff_schedule_versions"("tariff_schedule_id", "version");

-- CreateIndex
CREATE INDEX "reference_datasets_jurisdiction_code_idx" ON "reference_datasets"("jurisdiction_code");

-- CreateIndex
CREATE UNIQUE INDEX "reference_datasets_dataset_key_key" ON "reference_datasets"("dataset_key");

-- CreateIndex
CREATE INDEX "reference_dataset_versions_dataset_id_idx" ON "reference_dataset_versions"("dataset_id");

-- CreateIndex
CREATE INDEX "reference_dataset_versions_source_version_id_idx" ON "reference_dataset_versions"("source_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "reference_dataset_versions_dataset_id_version_key" ON "reference_dataset_versions"("dataset_id", "version");

-- CreateIndex
CREATE INDEX "rule_source_scopes_source_id_idx" ON "rule_source_scopes"("source_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_facility_id_idx" ON "rule_source_scopes"("facility_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_payer_id_idx" ON "rule_source_scopes"("payer_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_tpa_id_idx" ON "rule_source_scopes"("tpa_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_network_id_idx" ON "rule_source_scopes"("network_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_insurance_product_id_idx" ON "rule_source_scopes"("insurance_product_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_provider_contract_id_idx" ON "rule_source_scopes"("provider_contract_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_tariff_schedule_id_idx" ON "rule_source_scopes"("tariff_schedule_id");

-- CreateIndex
CREATE INDEX "rule_source_scopes_tariff_schedule_version_id_idx" ON "rule_source_scopes"("tariff_schedule_version_id");

-- AddForeignKey
ALTER TABLE "facility_regulatory_profiles" ADD CONSTRAINT "facility_regulatory_profiles_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_products" ADD CONSTRAINT "insurance_products_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_products" ADD CONSTRAINT "insurance_products_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_networks" ADD CONSTRAINT "product_networks_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_networks" ADD CONSTRAINT "product_networks_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_contracts" ADD CONSTRAINT "provider_contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_contracts" ADD CONSTRAINT "provider_contracts_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_contracts" ADD CONSTRAINT "provider_contracts_product_network_id_fkey" FOREIGN KEY ("product_network_id") REFERENCES "product_networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_facilities" ADD CONSTRAINT "contract_facilities_provider_contract_id_fkey" FOREIGN KEY ("provider_contract_id") REFERENCES "provider_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_facilities" ADD CONSTRAINT "contract_facilities_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_schedules" ADD CONSTRAINT "tariff_schedules_provider_contract_id_fkey" FOREIGN KEY ("provider_contract_id") REFERENCES "provider_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_schedule_versions" ADD CONSTRAINT "tariff_schedule_versions_tariff_schedule_id_fkey" FOREIGN KEY ("tariff_schedule_id") REFERENCES "tariff_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_dataset_versions" ADD CONSTRAINT "reference_dataset_versions_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "reference_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_dataset_versions" ADD CONSTRAINT "reference_dataset_versions_source_version_id_fkey" FOREIGN KEY ("source_version_id") REFERENCES "rule_source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rule_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_provider_contract_id_fkey" FOREIGN KEY ("provider_contract_id") REFERENCES "provider_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_tariff_schedule_id_fkey" FOREIGN KEY ("tariff_schedule_id") REFERENCES "tariff_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_scopes" ADD CONSTRAINT "rule_source_scopes_tariff_schedule_version_id_fkey" FOREIGN KEY ("tariff_schedule_version_id") REFERENCES "tariff_schedule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: controlled facility regulatory profile status (REF-01 / R1)
ALTER TABLE "facility_regulatory_profiles"
ADD CONSTRAINT "facility_regulatory_profiles_status_chk"
CHECK (status IN ('INACTIVE', 'ACTIVE'));

-- CHECK: effective-date ordering (REF-01 / R1)
ALTER TABLE "facility_regulatory_profiles"
ADD CONSTRAINT "facility_regulatory_profiles_effective_date_chk"
CHECK (effective_to IS NULL OR effective_from <= effective_to);

-- CHECK: controlled tariff schedule version verification status (REF-01 / R2)
ALTER TABLE "tariff_schedule_versions"
ADD CONSTRAINT "tariff_schedule_versions_verification_status_chk"
CHECK (verification_status IN ('UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'REJECTED'));

-- CHECK: verifiedAt must be set only when VERIFIED (REF-01 / R2)
ALTER TABLE "tariff_schedule_versions"
ADD CONSTRAINT "tariff_schedule_versions_verified_at_chk"
CHECK (
  (verification_status = 'VERIFIED' AND verified_at IS NOT NULL)
  OR
  (verification_status <> 'VERIFIED' AND verified_at IS NULL)
);

-- CHECK: effective-date ordering (REF-01 / R2)
ALTER TABLE "tariff_schedule_versions"
ADD CONSTRAINT "tariff_schedule_versions_effective_date_chk"
CHECK (
  effective_to IS NULL
  OR effective_from IS NULL
  OR effective_from <= effective_to
);

-- CHECK: controlled reference dataset version validation status (REF-01 / R3)
ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_validation_status_chk"
CHECK (validation_status IN ('PENDING', 'VALID', 'INVALID'));

-- CHECK: controlled reference dataset version activation status (REF-01 / R3)
ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_activation_status_chk"
CHECK (activation_status IN ('INACTIVE', 'ACTIVE', 'SUPERSEDED', 'RETIRED'));

-- CHECK: ACTIVE requires activatedAt, everything else must not carry one (REF-01 / R3)
ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_activated_at_chk"
CHECK (
  (activation_status = 'ACTIVE' AND activated_at IS NOT NULL)
  OR
  (activation_status <> 'ACTIVE' AND activated_at IS NULL)
);

-- CHECK: SUPERSEDED requires supersededAt (REF-01 / R3)
ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_superseded_at_chk"
CHECK (activation_status <> 'SUPERSEDED' OR superseded_at IS NOT NULL);

-- CHECK: RETIRED requires retiredAt (REF-01 / R3)
ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_retired_at_chk"
CHECK (activation_status <> 'RETIRED' OR retired_at IS NOT NULL);

-- CHECK: effective-date ordering (REF-01 / R3)
ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_effective_date_chk"
CHECK (
  effective_to IS NULL
  OR effective_from IS NULL
  OR effective_from <= effective_to
);

-- Exact-scope uniqueness: NULLS NOT DISTINCT prevents duplicate broad/partially-null
-- RuleSourceScope rows for the same RuleSource (REF-01 / R4, mirrors A3.6's exact-scope index).
CREATE UNIQUE INDEX "rule_source_scopes_exact_scope_uq"
ON "rule_source_scopes" (
  source_id,
  facility_id,
  payer_id,
  tpa_id,
  network_id,
  insurance_product_id,
  provider_contract_id,
  tariff_schedule_id,
  tariff_schedule_version_id
)
NULLS NOT DISTINCT;
