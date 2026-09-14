-- CreateTable
CREATE TABLE "rule_definitions" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "rule_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "ownership_scope" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_versions" (
    "id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "effect_type" TEXT NOT NULL,
    "effective_from" DATE,
    "effective_to" DATE,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_definitions_organization_id_idx" ON "rule_definitions"("organization_id");

-- CreateIndex
CREATE INDEX "rule_definitions_jurisdiction_code_idx" ON "rule_definitions"("jurisdiction_code");

-- CreateIndex
CREATE INDEX "rule_versions_rule_id_idx" ON "rule_versions"("rule_id");

-- CreateIndex
CREATE INDEX "rule_versions_effect_type_idx" ON "rule_versions"("effect_type");

-- CreateIndex
CREATE UNIQUE INDEX "rule_versions_rule_id_version_key" ON "rule_versions"("rule_id", "version");

-- AddForeignKey
ALTER TABLE "rule_definitions" ADD CONSTRAINT "rule_definitions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_versions" ADD CONSTRAINT "rule_versions_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "rule_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: ownership scope must match organization_id nullability (A3.5 hard gate)
ALTER TABLE "rule_definitions"
ADD CONSTRAINT "rule_definitions_ownership_scope_chk"
CHECK (
  (ownership_scope = 'SYSTEM_SHARED' AND organization_id IS NULL)
  OR
  (ownership_scope = 'ORGANIZATION' AND organization_id IS NOT NULL)
);

-- Partial unique index: ORGANIZATION-scoped ruleKey unique within (organizationId, jurisdictionCode)
CREATE UNIQUE INDEX "rule_definitions_org_key_uq"
ON "rule_definitions" ("organization_id", "jurisdiction_code", "rule_key")
WHERE ownership_scope = 'ORGANIZATION';

-- Partial unique index: SYSTEM_SHARED-scoped ruleKey unique within (jurisdictionCode)
CREATE UNIQUE INDEX "rule_definitions_shared_key_uq"
ON "rule_definitions" ("jurisdiction_code", "rule_key")
WHERE ownership_scope = 'SYSTEM_SHARED';

-- CHECK: controlled rule effect type (A3.5)
ALTER TABLE "rule_versions"
ADD CONSTRAINT "rule_versions_effect_type_chk"
CHECK (effect_type IN (
  'REFERENCE_ONLY',
  'PRICE_EFFECT',
  'TARIFF_EFFECT',
  'CLAIM_FORMAT_EFFECT',
  'CLAIM_EDIT_EFFECT',
  'REIMBURSEMENT_EFFECT',
  'AUTHORIZATION_REQUIREMENT_EFFECT',
  'ELIGIBILITY_REQUIREMENT_EFFECT',
  'DOCUMENTATION_REQUIREMENT_EFFECT'
));

-- CHECK: controlled verification status (A3.5)
ALTER TABLE "rule_versions"
ADD CONSTRAINT "rule_versions_verification_status_chk"
CHECK (verification_status IN ('UNVERIFIED', 'IN_REVIEW', 'VERIFIED', 'REJECTED'));

-- CHECK: verifiedAt must be set only when VERIFIED (A3.5)
ALTER TABLE "rule_versions"
ADD CONSTRAINT "rule_versions_verified_at_chk"
CHECK (
  (verification_status = 'VERIFIED' AND verified_at IS NOT NULL)
  OR
  (verification_status <> 'VERIFIED' AND verified_at IS NULL)
);

-- CHECK: effective-date ordering (A3.5)
ALTER TABLE "rule_versions"
ADD CONSTRAINT "rule_versions_effective_date_chk"
CHECK (
  effective_to IS NULL
  OR effective_from IS NULL
  OR effective_from <= effective_to
);
