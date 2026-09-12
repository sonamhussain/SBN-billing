-- CreateTable
CREATE TABLE "rule_source_versions" (
    "id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "raw_evidence_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_source_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_interpretations" (
    "id" UUID NOT NULL,
    "source_version_id" UUID NOT NULL,
    "interpretation_version" TEXT NOT NULL,
    "normalized_interpretation_ref" TEXT NOT NULL,
    "verification_status" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "source_interpretations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_source_versions_source_id_idx" ON "rule_source_versions"("source_id");

-- CreateIndex
CREATE UNIQUE INDEX "rule_source_versions_source_id_version_key" ON "rule_source_versions"("source_id", "version");

-- CreateIndex
CREATE INDEX "source_interpretations_source_version_id_idx" ON "source_interpretations"("source_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_interpretations_source_version_id_interpretation_ver_key" ON "source_interpretations"("source_version_id", "interpretation_version");

-- AddForeignKey
ALTER TABLE "rule_source_versions" ADD CONSTRAINT "rule_source_versions_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "rule_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_interpretations" ADD CONSTRAINT "source_interpretations_source_version_id_fkey" FOREIGN KEY ("source_version_id") REFERENCES "rule_source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: verification status and verifiedAt must not contradict each other (A3.2 hard gate)
ALTER TABLE "source_interpretations"
ADD CONSTRAINT "source_interpretations_verification_status_chk"
CHECK (
  (verification_status = 'VERIFIED' AND verified_at IS NOT NULL)
  OR
  (verification_status <> 'VERIFIED' AND verified_at IS NULL)
);
