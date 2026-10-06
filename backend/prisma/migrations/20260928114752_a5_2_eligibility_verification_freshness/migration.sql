-- A5.2 — Eligibility Verification & Freshness
--
-- Migration Drift Guard: the generator emitted seven statements that have nothing to do with A5.2 —
-- four Better Auth identifier defaults and three index removals it re-proposes on every generate.
-- They were removed by hand before this migration was ever applied, so the file below creates
-- exactly one table and nothing else is touched.
--
-- Note on freshness: there is deliberately no freshness column. FRESH / STALE / UNKNOWN is derived
-- at read time from valid_through, because a stored flag would be wrong the moment the clock moved
-- past it.

-- CreateTable
CREATE TABLE "eligibility_verifications" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "insurance_membership_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "tpa_id" UUID,
    "network_id" UUID,
    "insurance_product_id" UUID,
    "service_date" DATE NOT NULL,
    "verification_method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6),
    "responded_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_through" TIMESTAMPTZ(6),
    "authorization_required" BOOLEAN,
    "referral_required" BOOLEAN,
    "request_evidence_version_id" UUID,
    "response_evidence_version_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eligibility_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "eligibility_verifications_encounter_id_idx" ON "eligibility_verifications"("encounter_id");

-- CreateIndex
CREATE INDEX "eligibility_verifications_insurance_membership_id_idx" ON "eligibility_verifications"("insurance_membership_id");

-- CreateIndex
CREATE INDEX "eligibility_verifications_payer_id_idx" ON "eligibility_verifications"("payer_id");

-- CreateIndex
CREATE INDEX "eligibility_verifications_response_evidence_version_id_idx" ON "eligibility_verifications"("response_evidence_version_id");

-- CreateIndex
CREATE INDEX "eligibility_verifications_responded_at_idx" ON "eligibility_verifications"("responded_at");

-- CreateIndex
CREATE INDEX "eligibility_verifications_valid_through_idx" ON "eligibility_verifications"("valid_through");

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_insurance_membership_id_fkey" FOREIGN KEY ("insurance_membership_id") REFERENCES "insurance_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_request_evidence_version_id_fkey" FOREIGN KEY ("request_evidence_version_id") REFERENCES "evidence_artifact_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eligibility_verifications" ADD CONSTRAINT "eligibility_verifications_response_evidence_version_id_fkey" FOREIGN KEY ("response_evidence_version_id") REFERENCES "evidence_artifact_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.2 §12 — the vocabulary is closed at the database, not only in application validation. A row
-- that reached this table by any other path still cannot carry a status or method this domain does
-- not define. ACTIVE and INACTIVE are deliberately absent: they are registration words, not
-- eligibility results.
ALTER TABLE "eligibility_verifications"
  ADD CONSTRAINT "eligibility_verifications_status_chk"
  CHECK ("status" IN ('ELIGIBLE', 'INELIGIBLE', 'UNKNOWN'));

ALTER TABLE "eligibility_verifications"
  ADD CONSTRAINT "eligibility_verifications_method_chk"
  CHECK ("verification_method" IN ('ELECTRONIC', 'PORTAL', 'MANUAL', 'OTHER'));

-- A response cannot precede its own request, and a validity boundary cannot end before the response
-- that established it. Both allow NULL, because "not supplied" is a real answer and is not an
-- ordering violation.
ALTER TABLE "eligibility_verifications"
  ADD CONSTRAINT "eligibility_verifications_request_response_order_chk"
  CHECK ("requested_at" IS NULL OR "responded_at" >= "requested_at");

ALTER TABLE "eligibility_verifications"
  ADD CONSTRAINT "eligibility_verifications_validity_order_chk"
  CHECK ("valid_through" IS NULL OR "valid_through" >= "responded_at");

-- A5.2 §12 — an eligibility verification is a historical event. Correcting one means recording a
-- new verification, never editing or removing the earlier one, so the database refuses both
-- operations outright. This follows reference_dataset_lifecycle_events_append_only_trg and
-- evidence_artifact_versions_append_only_trg: the guarantee holds for every writer, including a
-- direct SQL session, not only for callers who go through the API.
CREATE OR REPLACE FUNCTION eligibility_verifications_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'eligibility_verifications is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER eligibility_verifications_append_only_trg
  BEFORE UPDATE OR DELETE ON "eligibility_verifications"
  FOR EACH ROW EXECUTE FUNCTION eligibility_verifications_append_only();
