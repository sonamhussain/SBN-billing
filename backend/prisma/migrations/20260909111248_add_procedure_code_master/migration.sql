-- AlterTable
ALTER TABLE "account" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "session" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "verification" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- CreateTable
CREATE TABLE "procedure_codes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "internal_code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "code_system" TEXT,
    "external_code" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedure_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "procedure_codes_organization_id_idx" ON "procedure_codes"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "procedure_codes_organization_id_internal_code_key" ON "procedure_codes"("organization_id", "internal_code");

-- AddForeignKey
ALTER TABLE "procedure_codes" ADD CONSTRAINT "procedure_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
