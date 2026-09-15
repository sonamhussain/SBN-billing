-- CreateTable
CREATE TABLE "rule_source_bindings" (
    "id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "source_interpretation_id" UUID NOT NULL,
    "source_role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_source_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rule_source_bindings_rule_version_id_idx" ON "rule_source_bindings"("rule_version_id");

-- CreateIndex
CREATE INDEX "rule_source_bindings_source_interpretation_id_idx" ON "rule_source_bindings"("source_interpretation_id");

-- CreateIndex
CREATE INDEX "rule_source_bindings_source_role_idx" ON "rule_source_bindings"("source_role");

-- CreateIndex
CREATE UNIQUE INDEX "rule_source_bindings_rule_version_id_source_interpretation__key" ON "rule_source_bindings"("rule_version_id", "source_interpretation_id");

-- AddForeignKey
ALTER TABLE "rule_source_bindings" ADD CONSTRAINT "rule_source_bindings_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_source_bindings" ADD CONSTRAINT "rule_source_bindings_source_interpretation_id_fkey" FOREIGN KEY ("source_interpretation_id") REFERENCES "source_interpretations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK: controlled source role (A3.7)
ALTER TABLE "rule_source_bindings"
ADD CONSTRAINT "rule_source_bindings_source_role_chk"
CHECK (source_role IN ('GOVERNING', 'SUPPORTING'));
