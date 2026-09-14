-- CreateTable
CREATE TABLE "rule_source_relationships" (
    "id" UUID NOT NULL,
    "from_source_version_id" UUID NOT NULL,
    "to_source_version_id" UUID NOT NULL,
    "relationship_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_source_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_source_relationships_from_source_version_id_idx" ON "rule_source_relationships"("from_source_version_id");

-- CreateIndex
CREATE INDEX "rule_source_relationships_to_source_version_id_idx" ON "rule_source_relationships"("to_source_version_id");

-- CreateIndex
CREATE INDEX "rule_source_relationships_relationship_type_idx" ON "rule_source_relationships"("relationship_type");

-- CreateIndex
CREATE UNIQUE INDEX "rule_source_relationships_from_source_version_id_to_source__key" ON "rule_source_relationships"("from_source_version_id", "to_source_version_id", "relationship_type");

-- AddForeignKey
ALTER TABLE "rule_source_relationships" ADD CONSTRAINT "rule_source_relationships_from_source_version_id_fkey" FOREIGN KEY ("from_source_version_id") REFERENCES "rule_source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_relationships" ADD CONSTRAINT "rule_source_relationships_to_source_version_id_fkey" FOREIGN KEY ("to_source_version_id") REFERENCES "rule_source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: a relationship cannot link a source version to itself (A3.4)
ALTER TABLE "rule_source_relationships"
ADD CONSTRAINT "rule_source_relationships_no_self_link_chk"
CHECK (from_source_version_id <> to_source_version_id);

-- CHECK: controlled relationship type (A3.4)
ALTER TABLE "rule_source_relationships"
ADD CONSTRAINT "rule_source_relationships_type_chk"
CHECK (relationship_type IN ('SUPERSEDES', 'AMENDS', 'REFERENCES', 'DEPENDS_ON', 'CONFLICTS_WITH'));
