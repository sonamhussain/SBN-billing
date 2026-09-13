-- AlterTable
ALTER TABLE "rule_source_versions" ADD COLUMN     "activated_at" TIMESTAMPTZ(6),
ADD COLUMN     "activation_blockers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "activation_status" TEXT NOT NULL DEFAULT 'INACTIVE',
ADD COLUMN     "effective_from" DATE,
ADD COLUMN     "effective_to" DATE,
ADD COLUMN     "publication_date" DATE,
ADD COLUMN     "publication_status" TEXT NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "retired_at" TIMESTAMPTZ(6),
ADD COLUMN     "superseded_at" TIMESTAMPTZ(6),
ADD COLUMN     "suspended_at" TIMESTAMPTZ(6),
ADD COLUMN     "verification_status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "verified_at" TIMESTAMPTZ(6);

-- CHECK: controlled publication status (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_publication_status_chk"
CHECK (publication_status IN ('DRAFT','PUBLISHED'));

-- CHECK: controlled source verification status (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_verification_status_chk"
CHECK (verification_status IN ('UNVERIFIED','IN_REVIEW','VERIFIED','REJECTED'));

-- CHECK: controlled activation status (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_activation_status_chk"
CHECK (activation_status IN ('INACTIVE','BLOCKED','ACTIVE','SUSPENDED','SUPERSEDED','RETIRED'));

-- CHECK: publication requires publicationDate (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_publication_date_chk"
CHECK (publication_status <> 'PUBLISHED' OR publication_date IS NOT NULL);

-- CHECK: source verification status/verifiedAt must not contradict each other (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_verified_at_chk"
CHECK (
  (verification_status = 'VERIFIED' AND verified_at IS NOT NULL)
  OR
  (verification_status <> 'VERIFIED' AND verified_at IS NULL)
);

-- CHECK: effective period must not be inverted (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_effective_period_chk"
CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_from <= effective_to);

-- CHECK: ACTIVE requires activatedAt and zero blockers (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_active_chk"
CHECK (activation_status <> 'ACTIVE' OR (activated_at IS NOT NULL AND cardinality(activation_blockers) = 0));

-- CHECK: BLOCKED requires no activatedAt and at least one blocker (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_blocked_chk"
CHECK (activation_status <> 'BLOCKED' OR (activated_at IS NULL AND cardinality(activation_blockers) > 0));

-- CHECK: SUSPENDED requires suspendedAt (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_suspended_at_chk"
CHECK (activation_status <> 'SUSPENDED' OR suspended_at IS NOT NULL);

-- CHECK: RETIRED requires retiredAt (A3.3)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_retired_at_chk"
CHECK (activation_status <> 'RETIRED' OR retired_at IS NOT NULL);

-- CHECK: SUPERSEDED requires supersededAt (A3.3, reserved for A3.4 transition)
ALTER TABLE "rule_source_versions"
ADD CONSTRAINT "rule_source_versions_superseded_at_chk"
CHECK (activation_status <> 'SUPERSEDED' OR superseded_at IS NOT NULL);
