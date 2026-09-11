-- AlterTable
ALTER TABLE "account" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "session" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "verification" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- CreateTable
CREATE TABLE "rule_sources" (
    "id" UUID NOT NULL,
    "organization_id" UUID,
    "jurisdiction_code" TEXT NOT NULL,
    "issuing_authority" TEXT NOT NULL,
    "source_category" TEXT NOT NULL,
    "reference_number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownership_scope" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rule_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_sources_organization_id_idx" ON "rule_sources"("organization_id");

-- CreateIndex
CREATE INDEX "rule_sources_jurisdiction_code_idx" ON "rule_sources"("jurisdiction_code");

-- CreateIndex
CREATE INDEX "rule_sources_source_category_idx" ON "rule_sources"("source_category");

-- AddForeignKey
ALTER TABLE "rule_sources" ADD CONSTRAINT "rule_sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: ownership scope must match organization_id nullability (A3.1 hard gate)
ALTER TABLE "rule_sources"
ADD CONSTRAINT "rule_sources_ownership_scope_chk"
CHECK (
  (ownership_scope = 'SYSTEM_SHARED' AND organization_id IS NULL)
  OR
  (ownership_scope = 'ORGANIZATION' AND organization_id IS NOT NULL)
);
