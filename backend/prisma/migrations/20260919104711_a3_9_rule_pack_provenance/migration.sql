-- A3.9 — Rule Pack Version & Provenance Contract (v1.1).
--
-- Creates ONLY rule_packs, rule_pack_versions and rule_pack_members, with their foreign keys
-- (all ON DELETE RESTRICT, so governed history can never be cascade-deleted), indexes and the
-- constraints the package requires. No RuleDecision, patient, eligibility, authorization, claim,
-- remittance, pricing, provenance-snapshot or adapter table. No change to any existing table's
-- columns: the Organization and RuleVersion changes in schema.prisma are Prisma back-relations
-- only and generate no SQL.
--
-- Migration Drift Guard applied to the generated SQL: the four recurring auth-table
-- "ALTER COLUMN id SET DEFAULT" lines and the two spurious DROP INDEX statements for the
-- hand-written NULLS NOT DISTINCT indexes (rule_applicabilities_exact_scope_uq,
-- rule_source_scopes_exact_scope_uq) were removed. The hand-written objects added below must be
-- preserved the same way in every later migration.

-- CreateTable
CREATE TABLE "rule_packs" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "pack_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "ownership_scope" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_packs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_pack_versions" (
    "id" UUID NOT NULL,
    "rule_pack_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "effective_from" DATE,
    "effective_to" DATE,
    "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verified_at" TIMESTAMPTZ(6),
    "activation_status" TEXT NOT NULL DEFAULT 'INACTIVE',
    "activated_at" TIMESTAMPTZ(6),
    "superseded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_pack_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_pack_members" (
    "id" UUID NOT NULL,
    "rule_pack_version_id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_pack_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_packs_organization_id_idx" ON "rule_packs"("organization_id");

-- CreateIndex
CREATE INDEX "rule_packs_jurisdiction_code_idx" ON "rule_packs"("jurisdiction_code");

-- CreateIndex
CREATE INDEX "rule_pack_versions_rule_pack_id_idx" ON "rule_pack_versions"("rule_pack_id");

-- CreateIndex
CREATE INDEX "rule_pack_versions_verification_status_idx" ON "rule_pack_versions"("verification_status");

-- CreateIndex
CREATE INDEX "rule_pack_versions_activation_status_idx" ON "rule_pack_versions"("activation_status");

-- CreateIndex
CREATE UNIQUE INDEX "rule_pack_versions_rule_pack_id_version_key" ON "rule_pack_versions"("rule_pack_id", "version");

-- CreateIndex
CREATE INDEX "rule_pack_members_rule_pack_version_id_idx" ON "rule_pack_members"("rule_pack_version_id");

-- CreateIndex
CREATE INDEX "rule_pack_members_rule_version_id_idx" ON "rule_pack_members"("rule_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_pack_members_rule_pack_version_id_rule_version_id_key" ON "rule_pack_members"("rule_pack_version_id", "rule_version_id");

-- AddForeignKey
ALTER TABLE "rule_packs" ADD CONSTRAINT "rule_packs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_pack_versions" ADD CONSTRAINT "rule_pack_versions_rule_pack_id_fkey" FOREIGN KEY ("rule_pack_id") REFERENCES "rule_packs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_pack_members" ADD CONSTRAINT "rule_pack_members_rule_pack_version_id_fkey" FOREIGN KEY ("rule_pack_version_id") REFERENCES "rule_pack_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_pack_members" ADD CONSTRAINT "rule_pack_members_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- Hand-written constraints (A3.9 §9). Prisma's DSL cannot express these.
-- ---------------------------------------------------------------------------------------------

-- Ownership: SYSTEM_SHARED => organization_id IS NULL; ORGANIZATION => organization_id IS NOT NULL.
ALTER TABLE "rule_packs"
ADD CONSTRAINT "rule_packs_ownership_scope_chk"
CHECK (
  (ownership_scope = 'SYSTEM_SHARED' AND organization_id IS NULL)
  OR
  (ownership_scope = 'ORGANIZATION' AND organization_id IS NOT NULL)
);

-- Pack-key uniqueness within the ownership/organization scope. NULLS NOT DISTINCT makes the
-- SYSTEM_SHARED scope (organization_id NULL) a single scope too, so two shared packs can never
-- share a key.
CREATE UNIQUE INDEX "rule_packs_scope_pack_key_uq"
ON "rule_packs" ("organization_id", "pack_key") NULLS NOT DISTINCT;

-- Effective dates: open ends allowed, never an inverted period.
ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_effective_date_chk"
CHECK (
  effective_to IS NULL
  OR effective_from IS NULL
  OR effective_to >= effective_from
);

-- Controlled vocabularies: the four lifecycle states are the only valid combinations.
ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_verification_status_chk"
CHECK (verification_status IN ('UNVERIFIED', 'VERIFIED'));

ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_activation_status_chk"
CHECK (activation_status IN ('INACTIVE', 'ACTIVE', 'SUPERSEDED'));

-- VERIFIED requires verified_at (and only VERIFIED carries it), as for rule_versions.
ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_verified_at_chk"
CHECK (
  (verification_status = 'VERIFIED' AND verified_at IS NOT NULL)
  OR
  (verification_status <> 'VERIFIED' AND verified_at IS NULL)
);

-- Only a VERIFIED snapshot can ever be ACTIVE or SUPERSEDED.
ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_lifecycle_chk"
CHECK (activation_status = 'INACTIVE' OR verification_status = 'VERIFIED');

-- ACTIVE requires activated_at. A SUPERSEDED version keeps its activation evidence; an INACTIVE
-- one has never been activated (the lifecycle never returns to INACTIVE).
ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_activated_at_chk"
CHECK (
  (activation_status = 'INACTIVE' AND activated_at IS NULL)
  OR
  (activation_status IN ('ACTIVE', 'SUPERSEDED') AND activated_at IS NOT NULL)
);

-- SUPERSEDED carries superseded_at, and nothing else does.
ALTER TABLE "rule_pack_versions"
ADD CONSTRAINT "rule_pack_versions_superseded_at_chk"
CHECK (
  (activation_status = 'SUPERSEDED' AND superseded_at IS NOT NULL)
  OR
  (activation_status <> 'SUPERSEDED' AND superseded_at IS NULL)
);

-- One ACTIVE version per pack: the final race guard behind the service's parent-level lock.
CREATE UNIQUE INDEX "rule_pack_versions_one_active_uq"
ON "rule_pack_versions" ("rule_pack_id")
WHERE activation_status = 'ACTIVE';
