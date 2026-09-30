-- A5.3 — Prior Authorization Lifecycle
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A5.3 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly three
-- tables and touches nothing else.
--
-- Note on validity: there is deliberately no EXPIRED or ACTIVE status column. Validity is the
-- valid_from / valid_through pair, and whether an authorization applies to a claim context is
-- decided later by A5.4 and A5.8.

-- CreateTable
CREATE TABLE "prior_authorizations" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "insurance_membership_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "tpa_id" UUID,
    "network_id" UUID,
    "insurance_product_id" UUID,
    "facility_id" UUID NOT NULL,
    "clinician_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prior_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prior_authorization_versions" (
    "id" UUID NOT NULL,
    "prior_authorization_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "version_kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "authorization_reference" TEXT,
    "eligibility_verification_id" UUID,
    "requested_at" TIMESTAMPTZ(6),
    "responded_at" TIMESTAMPTZ(6),
    "valid_from" DATE,
    "valid_through" DATE,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prior_authorization_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prior_authorization_version_evidence" (
    "id" UUID NOT NULL,
    "prior_authorization_version_id" UUID NOT NULL,
    "evidence_artifact_version_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prior_authorization_version_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prior_authorizations_encounter_id_idx" ON "prior_authorizations"("encounter_id");

-- CreateIndex
CREATE INDEX "prior_authorizations_insurance_membership_id_idx" ON "prior_authorizations"("insurance_membership_id");

-- CreateIndex
CREATE INDEX "prior_authorizations_payer_id_idx" ON "prior_authorizations"("payer_id");

-- CreateIndex
CREATE INDEX "prior_authorizations_facility_id_idx" ON "prior_authorizations"("facility_id");

-- CreateIndex
CREATE INDEX "prior_authorizations_clinician_id_idx" ON "prior_authorizations"("clinician_id");

-- CreateIndex
CREATE INDEX "prior_authorization_versions_prior_authorization_id_idx" ON "prior_authorization_versions"("prior_authorization_id");

-- CreateIndex
CREATE INDEX "prior_authorization_versions_eligibility_verification_id_idx" ON "prior_authorization_versions"("eligibility_verification_id");

-- CreateIndex
CREATE INDEX "prior_authorization_versions_status_idx" ON "prior_authorization_versions"("status");

-- CreateIndex
CREATE INDEX "prior_authorization_versions_valid_through_idx" ON "prior_authorization_versions"("valid_through");

-- CreateIndex
CREATE UNIQUE INDEX "prior_authorization_versions_prior_authorization_id_version_key" ON "prior_authorization_versions"("prior_authorization_id", "version");

-- CreateIndex
CREATE INDEX "prior_authorization_version_evidence_prior_authorization_ve_idx" ON "prior_authorization_version_evidence"("prior_authorization_version_id");

-- CreateIndex
CREATE INDEX "prior_authorization_version_evidence_evidence_artifact_vers_idx" ON "prior_authorization_version_evidence"("evidence_artifact_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "prior_authorization_version_evidence_prior_authorization_ve_key" ON "prior_authorization_version_evidence"("prior_authorization_version_id", "evidence_artifact_version_id", "role");

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_insurance_membership_id_fkey" FOREIGN KEY ("insurance_membership_id") REFERENCES "insurance_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorizations" ADD CONSTRAINT "prior_authorizations_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "clinicians"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization_versions" ADD CONSTRAINT "prior_authorization_versions_prior_authorization_id_fkey" FOREIGN KEY ("prior_authorization_id") REFERENCES "prior_authorizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization_versions" ADD CONSTRAINT "prior_authorization_versions_eligibility_verification_id_fkey" FOREIGN KEY ("eligibility_verification_id") REFERENCES "eligibility_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization_versions" ADD CONSTRAINT "prior_authorization_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization_version_evidence" ADD CONSTRAINT "prior_authorization_version_evidence_prior_authorization_v_fkey" FOREIGN KEY ("prior_authorization_version_id") REFERENCES "prior_authorization_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prior_authorization_version_evidence" ADD CONSTRAINT "prior_authorization_version_evidence_evidence_artifact_ver_fkey" FOREIGN KEY ("evidence_artifact_version_id") REFERENCES "evidence_artifact_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.3 §12 — the three vocabularies are closed at the database, not only in application validation.
-- A row that reached these tables by any other path still cannot carry a kind, status or evidence
-- role this domain does not define.
ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_version_positive_chk" CHECK ("version" >= 1);

ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_kind_chk"
  CHECK ("version_kind" IN ('INITIAL', 'RESPONSE', 'AMENDMENT', 'EXTENSION', 'CORRECTION'));

ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_status_chk"
  CHECK ("status" IN ('REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'));

ALTER TABLE "prior_authorization_version_evidence"
  ADD CONSTRAINT "prior_authorization_version_evidence_role_chk"
  CHECK ("role" IN ('REQUEST', 'RESPONSE', 'SUPPORTING'));

-- An authorization reference is optional, but a blank one is not an answer. There is deliberately
-- no uniqueness on it: payer semantics are external, and a reference may be absent or reused.
ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_reference_nonblank_chk"
  CHECK ("authorization_reference" IS NULL OR btrim("authorization_reference") <> '');

-- A response cannot precede its own request, and a validity window cannot end before it begins.
-- Both allow NULL, because "not supplied" is a real answer rather than an ordering violation.
ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_timing_order_chk"
  CHECK ("requested_at" IS NULL OR "responded_at" IS NULL OR "responded_at" >= "requested_at");

ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_validity_order_chk"
  CHECK ("valid_from" IS NULL OR "valid_through" IS NULL OR "valid_through" >= "valid_from");

-- A decision the payer actually made must say when it was made. REQUESTED, PENDING and UNKNOWN
-- carry no such obligation, because nothing was decided.
ALTER TABLE "prior_authorization_versions"
  ADD CONSTRAINT "prior_authorization_versions_decision_response_chk"
  CHECK ("status" NOT IN ('APPROVED', 'PARTIALLY_APPROVED', 'DENIED') OR "responded_at" IS NOT NULL);

-- A5.3 §12 — an authorization case, its lifecycle versions and the evidence backing them are all
-- historical fact. A correction is a new version, never an edit, and the guarantee holds for every
-- writer including a direct SQL session. This follows the A5.1 and A5.2 append-only triggers.
CREATE OR REPLACE FUNCTION prior_authorizations_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'prior_authorizations is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prior_authorizations_append_only_trg
  BEFORE UPDATE OR DELETE ON "prior_authorizations"
  FOR EACH ROW EXECUTE FUNCTION prior_authorizations_append_only();

CREATE OR REPLACE FUNCTION prior_authorization_versions_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'prior_authorization_versions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prior_authorization_versions_append_only_trg
  BEFORE UPDATE OR DELETE ON "prior_authorization_versions"
  FOR EACH ROW EXECUTE FUNCTION prior_authorization_versions_append_only();

CREATE OR REPLACE FUNCTION prior_authorization_version_evidence_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'prior_authorization_version_evidence is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prior_authorization_version_evidence_append_only_trg
  BEFORE UPDATE OR DELETE ON "prior_authorization_version_evidence"
  FOR EACH ROW EXECUTE FUNCTION prior_authorization_version_evidence_append_only();
