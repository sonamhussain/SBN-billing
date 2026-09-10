-- AlterTable
ALTER TABLE "account" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "session" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "user" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- AlterTable
ALTER TABLE "verification" ALTER COLUMN "id" SET DEFAULT pg_catalog.gen_random_uuid();

-- CreateTable
CREATE TABLE "diagnosis_codes" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "diagnosis_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "diagnosis_codes_organization_id_idx" ON "diagnosis_codes"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnosis_codes_organization_id_code_key" ON "diagnosis_codes"("organization_id", "code");

-- AddForeignKey
ALTER TABLE "diagnosis_codes" ADD CONSTRAINT "diagnosis_codes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
