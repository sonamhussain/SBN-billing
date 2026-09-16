/*
  Warnings:

  - You are about to drop the column `product_network_id` on the `provider_contracts` table. All the data in the column will be lost.
  - Added the required column `effective_from` to the `provider_contracts` table without a default value. This is not possible if the table is not empty.
  - Added the required column `payer_id` to the `provider_contracts` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "provider_contracts" DROP CONSTRAINT "provider_contracts_product_network_id_fkey";

-- DropIndex
DROP INDEX "provider_contracts_product_network_id_idx";

-- AlterTable
ALTER TABLE "provider_contracts" DROP COLUMN "product_network_id",
ADD COLUMN     "effective_from" DATE NOT NULL,
ADD COLUMN     "effective_to" DATE,
ADD COLUMN     "network_id" UUID,
ADD COLUMN     "payer_id" UUID NOT NULL,
ADD COLUMN     "tpa_id" UUID;

-- CreateIndex
CREATE INDEX "provider_contracts_payer_id_idx" ON "provider_contracts"("payer_id");

-- CreateIndex
CREATE INDEX "provider_contracts_tpa_id_idx" ON "provider_contracts"("tpa_id");

-- CreateIndex
CREATE INDEX "provider_contracts_network_id_idx" ON "provider_contracts"("network_id");

-- AddForeignKey
ALTER TABLE "provider_contracts" ADD CONSTRAINT "provider_contracts_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_contracts" ADD CONSTRAINT "provider_contracts_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_contracts" ADD CONSTRAINT "provider_contracts_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: effective-date ordering (REF-01 §6 T34)
ALTER TABLE "provider_contracts"
ADD CONSTRAINT "provider_contracts_effective_date_chk"
CHECK (effective_to IS NULL OR effective_from <= effective_to);

-- Fix: gap-correction audit found the reference dataset version validation_status values did not
-- match the doc's controlled vocabulary (UNVALIDATED/VALIDATED/REJECTED, not PENDING/VALID/INVALID).
ALTER TABLE "reference_dataset_versions"
DROP CONSTRAINT "reference_dataset_versions_validation_status_chk";

ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_validation_status_chk"
CHECK (validation_status IN ('UNVALIDATED', 'VALIDATED', 'REJECTED'));
