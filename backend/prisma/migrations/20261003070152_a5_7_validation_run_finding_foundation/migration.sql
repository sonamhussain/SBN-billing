-- A5.7 — Validation Run & Finding Foundation
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A5.7 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly two
-- tables and touches nothing else.
--
-- A5.7 stores results; it does not execute validation. There is no run status, no current/latest
-- pointer, no overall outcome and no readiness column: a later validation is another run.

-- CreateTable
CREATE TABLE "validation_runs" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "service_date" DATE NOT NULL,
    "facility_id" UUID NOT NULL,
    "facility_regulatory_profile_id" UUID NOT NULL,
    "insurance_membership_id" UUID,
    "payer_id" UUID,
    "tpa_id" UUID,
    "network_id" UUID,
    "insurance_product_id" UUID,
    "provider_contract_id" UUID,
    "tariff_schedule_id" UUID,
    "tariff_schedule_version_id" UUID,
    "validator_version" TEXT NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validation_findings" (
    "id" UUID NOT NULL,
    "validation_run_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "layer" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "finding_code" TEXT NOT NULL,
    "field_path" TEXT,
    "message" TEXT NOT NULL,
    "rule_version_id" UUID,
    "governing_source_version_id" UUID,
    "reference_dataset_version_id" UUID,
    "encounter_activity_id" UUID,
    "encounter_diagnosis_id" UUID,
    "eligibility_verification_id" UUID,
    "prior_authorization_version_id" UUID,
    "authorization_line_id" UUID,
    "evidence_requirement_id" UUID,
    "evidence_artifact_version_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "validation_runs_encounter_id_evaluated_at_idx" ON "validation_runs"("encounter_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "validation_runs_provider_contract_id_idx" ON "validation_runs"("provider_contract_id");

-- CreateIndex
CREATE INDEX "validation_runs_tariff_schedule_version_id_idx" ON "validation_runs"("tariff_schedule_version_id");

-- CreateIndex
CREATE INDEX "validation_findings_validation_run_id_idx" ON "validation_findings"("validation_run_id");

-- CreateIndex
CREATE INDEX "validation_findings_layer_outcome_idx" ON "validation_findings"("layer", "outcome");

-- CreateIndex
CREATE INDEX "validation_findings_finding_code_idx" ON "validation_findings"("finding_code");

-- CreateIndex
CREATE INDEX "validation_findings_rule_version_id_idx" ON "validation_findings"("rule_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "validation_findings_validation_run_id_sequence_key" ON "validation_findings"("validation_run_id", "sequence");

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "facilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_facility_regulatory_profile_id_fkey" FOREIGN KEY ("facility_regulatory_profile_id") REFERENCES "facility_regulatory_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_insurance_membership_id_fkey" FOREIGN KEY ("insurance_membership_id") REFERENCES "insurance_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_tpa_id_fkey" FOREIGN KEY ("tpa_id") REFERENCES "tpas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_network_id_fkey" FOREIGN KEY ("network_id") REFERENCES "networks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_insurance_product_id_fkey" FOREIGN KEY ("insurance_product_id") REFERENCES "insurance_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_provider_contract_id_fkey" FOREIGN KEY ("provider_contract_id") REFERENCES "provider_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_tariff_schedule_id_fkey" FOREIGN KEY ("tariff_schedule_id") REFERENCES "tariff_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_tariff_schedule_version_id_fkey" FOREIGN KEY ("tariff_schedule_version_id") REFERENCES "tariff_schedule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_validation_run_id_fkey" FOREIGN KEY ("validation_run_id") REFERENCES "validation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_governing_source_version_id_fkey" FOREIGN KEY ("governing_source_version_id") REFERENCES "rule_source_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_reference_dataset_version_id_fkey" FOREIGN KEY ("reference_dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_encounter_activity_id_fkey" FOREIGN KEY ("encounter_activity_id") REFERENCES "encounter_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_encounter_diagnosis_id_fkey" FOREIGN KEY ("encounter_diagnosis_id") REFERENCES "encounter_diagnoses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_eligibility_verification_id_fkey" FOREIGN KEY ("eligibility_verification_id") REFERENCES "eligibility_verifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_prior_authorization_version_id_fkey" FOREIGN KEY ("prior_authorization_version_id") REFERENCES "prior_authorization_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_authorization_line_id_fkey" FOREIGN KEY ("authorization_line_id") REFERENCES "authorization_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_evidence_requirement_id_fkey" FOREIGN KEY ("evidence_requirement_id") REFERENCES "evidence_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_findings" ADD CONSTRAINT "validation_findings_evidence_artifact_version_id_fkey" FOREIGN KEY ("evidence_artifact_version_id") REFERENCES "evidence_artifact_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.7 §13 — the controlled vocabularies and safe-text bounds are held by the database too, not
-- only by the recorder's own validation.
ALTER TABLE "validation_runs"
  ADD CONSTRAINT "validation_runs_validator_version_chk" CHECK (btrim("validator_version") <> '' AND "validator_version" = btrim("validator_version") AND char_length("validator_version") <= 96);

ALTER TABLE "validation_findings"
  ADD CONSTRAINT "validation_findings_sequence_positive_chk" CHECK ("sequence" >= 1);

ALTER TABLE "validation_findings"
  ADD CONSTRAINT "validation_findings_layer_chk" CHECK ("layer" IN ('TECHNICAL', 'CODING', 'COVERAGE', 'CONTRACT', 'EVIDENCE'));

ALTER TABLE "validation_findings"
  ADD CONSTRAINT "validation_findings_outcome_chk" CHECK ("outcome" IN ('PASS', 'WARNING', 'RESTRICT', 'FAIL'));

-- A stable machine-readable token: uppercase, starting with a letter, at most 96 characters.
ALTER TABLE "validation_findings"
  ADD CONSTRAINT "validation_findings_finding_code_chk" CHECK ("finding_code" ~ '^[A-Z][A-Z0-9_]{0,95}$');

ALTER TABLE "validation_findings"
  ADD CONSTRAINT "validation_findings_message_chk" CHECK (btrim("message") <> '' AND "message" = btrim("message") AND char_length("message") <= 512);

ALTER TABLE "validation_findings"
  ADD CONSTRAINT "validation_findings_field_path_chk" CHECK ("field_path" IS NULL OR (btrim("field_path") <> '' AND "field_path" = btrim("field_path") AND char_length("field_path") <= 256));

-- A5.7 §3/§13 — a run and its findings are historical evidence. The database refuses UPDATE and
-- DELETE on both tables for every writer, including a direct SQL session. Re-validation is a new run.
CREATE OR REPLACE FUNCTION validation_runs_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'validation_runs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validation_runs_append_only_trg
  BEFORE UPDATE OR DELETE ON "validation_runs"
  FOR EACH ROW EXECUTE FUNCTION validation_runs_append_only();

CREATE OR REPLACE FUNCTION validation_findings_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'validation_findings is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validation_findings_append_only_trg
  BEFORE UPDATE OR DELETE ON "validation_findings"
  FOR EACH ROW EXECUTE FUNCTION validation_findings_append_only();

-- Owner-approved addition to §13: a run is one complete atomic snapshot, so its finding set is
-- closed when its transaction commits. A finding may only be inserted by the transaction that
-- inserted its run (the run row's xmin is that transaction, and the row can never be updated).
CREATE OR REPLACE FUNCTION validation_findings_same_transaction()
RETURNS TRIGGER AS $$
DECLARE
  run_xmin xid;
BEGIN
  SELECT xmin INTO run_xmin FROM "validation_runs" WHERE "id" = NEW."validation_run_id";
  IF run_xmin IS NOT NULL AND run_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'validation_findings: a finding can only be recorded with its own run, never added to an earlier run'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validation_findings_same_transaction_trg
  BEFORE INSERT ON "validation_findings"
  FOR EACH ROW EXECUTE FUNCTION validation_findings_same_transaction();

-- A5.7 §3/§13 — a run can never commit without at least one finding. The check is deferred to
-- commit, so the recorder can insert the run first and its findings after it in the same
-- transaction.
CREATE OR REPLACE FUNCTION validation_runs_require_findings()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "validation_findings" WHERE "validation_run_id" = NEW."id") THEN
    RAISE EXCEPTION 'validation_runs: a run cannot be committed without at least one finding'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER validation_runs_require_findings_trg
  AFTER INSERT ON "validation_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validation_runs_require_findings();
