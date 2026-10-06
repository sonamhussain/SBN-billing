-- A5.8 — Layered Deterministic Pre-Claim Validation & Provenance
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A5.8 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly the four
-- normalized provenance tables and touches nothing else. ValidationRun and ValidationFinding (A5.7)
-- are not altered.

-- CreateTable
CREATE TABLE "validation_finding_rule_provenances" (
    "validation_finding_id" UUID NOT NULL,
    "provenance_contract_version" TEXT NOT NULL,
    "precedence_policy_version" TEXT NOT NULL,
    "rule_pack_version_id" UUID,
    "governing_binding_id" UUID NOT NULL,
    "governing_source_interpretation_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "evaluation_timestamp" TIMESTAMPTZ(6) NOT NULL,
    "historical_only" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_finding_rule_provenances_pkey" PRIMARY KEY ("validation_finding_id")
);

-- CreateTable
CREATE TABLE "validation_finding_supporting_bindings" (
    "validation_finding_id" UUID NOT NULL,
    "rule_source_binding_id" UUID NOT NULL,

    CONSTRAINT "validation_finding_supporting_bindings_pkey" PRIMARY KEY ("validation_finding_id","rule_source_binding_id")
);

-- CreateTable
CREATE TABLE "validation_finding_matched_applicabilities" (
    "validation_finding_id" UUID NOT NULL,
    "rule_applicability_id" UUID NOT NULL,

    CONSTRAINT "validation_finding_matched_applicabilities_pkey" PRIMARY KEY ("validation_finding_id","rule_applicability_id")
);

-- CreateTable
CREATE TABLE "validation_finding_reference_dataset_versions" (
    "validation_finding_id" UUID NOT NULL,
    "reference_dataset_version_id" UUID NOT NULL,

    CONSTRAINT "validation_finding_reference_dataset_versions_pkey" PRIMARY KEY ("validation_finding_id","reference_dataset_version_id")
);

-- CreateIndex
CREATE INDEX "validation_finding_rule_provenances_governing_binding_id_idx" ON "validation_finding_rule_provenances"("governing_binding_id");

-- CreateIndex
CREATE INDEX "validation_finding_rule_provenances_rule_pack_version_id_idx" ON "validation_finding_rule_provenances"("rule_pack_version_id");

-- CreateIndex
CREATE INDEX "validation_finding_supporting_bindings_rule_source_binding__idx" ON "validation_finding_supporting_bindings"("rule_source_binding_id");

-- CreateIndex
CREATE INDEX "validation_finding_matched_applicabilities_rule_applicabili_idx" ON "validation_finding_matched_applicabilities"("rule_applicability_id");

-- CreateIndex
CREATE INDEX "validation_finding_reference_dataset_versions_reference_dat_idx" ON "validation_finding_reference_dataset_versions"("reference_dataset_version_id");

-- AddForeignKey
ALTER TABLE "validation_finding_rule_provenances" ADD CONSTRAINT "validation_finding_rule_provenances_validation_finding_id_fkey" FOREIGN KEY ("validation_finding_id") REFERENCES "validation_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_rule_provenances" ADD CONSTRAINT "validation_finding_rule_provenances_rule_pack_version_id_fkey" FOREIGN KEY ("rule_pack_version_id") REFERENCES "rule_pack_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_rule_provenances" ADD CONSTRAINT "validation_finding_rule_provenances_governing_binding_id_fkey" FOREIGN KEY ("governing_binding_id") REFERENCES "rule_source_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_rule_provenances" ADD CONSTRAINT "validation_finding_rule_provenances_governing_source_inter_fkey" FOREIGN KEY ("governing_source_interpretation_id") REFERENCES "source_interpretations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_supporting_bindings" ADD CONSTRAINT "validation_finding_supporting_bindings_validation_finding__fkey" FOREIGN KEY ("validation_finding_id") REFERENCES "validation_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_supporting_bindings" ADD CONSTRAINT "validation_finding_supporting_bindings_rule_source_binding_fkey" FOREIGN KEY ("rule_source_binding_id") REFERENCES "rule_source_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_matched_applicabilities" ADD CONSTRAINT "validation_finding_matched_applicabilities_validation_find_fkey" FOREIGN KEY ("validation_finding_id") REFERENCES "validation_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_matched_applicabilities" ADD CONSTRAINT "validation_finding_matched_applicabilities_rule_applicabil_fkey" FOREIGN KEY ("rule_applicability_id") REFERENCES "rule_applicabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_reference_dataset_versions" ADD CONSTRAINT "validation_finding_reference_dataset_versions_validation_f_fkey" FOREIGN KEY ("validation_finding_id") REFERENCES "validation_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validation_finding_reference_dataset_versions" ADD CONSTRAINT "validation_finding_reference_dataset_versions_reference_da_fkey" FOREIGN KEY ("reference_dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.8 §16/§17 — the provenance labels are copied verbatim from A3; the database keeps them trimmed
-- and nonblank. The exact A3-PROV-1 value is enforced by the recorder of this provenance.
ALTER TABLE "validation_finding_rule_provenances"
  ADD CONSTRAINT "validation_finding_rule_provenances_contract_version_chk" CHECK (btrim("provenance_contract_version") <> '' AND "provenance_contract_version" = btrim("provenance_contract_version"));

ALTER TABLE "validation_finding_rule_provenances"
  ADD CONSTRAINT "validation_finding_rule_provenances_policy_version_chk" CHECK (btrim("precedence_policy_version") <> '' AND "precedence_policy_version" = btrim("precedence_policy_version"));

-- A5.8 §16 — all four provenance tables are append-only. The database refuses UPDATE and DELETE for
-- every writer, including a direct SQL session.
CREATE OR REPLACE FUNCTION validation_provenance_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validation_finding_rule_provenances_append_only_trg
  BEFORE UPDATE OR DELETE ON "validation_finding_rule_provenances"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_append_only();

CREATE TRIGGER validation_finding_supporting_bindings_append_only_trg
  BEFORE UPDATE OR DELETE ON "validation_finding_supporting_bindings"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_append_only();

CREATE TRIGGER validation_finding_matched_applicabilities_append_only_trg
  BEFORE UPDATE OR DELETE ON "validation_finding_matched_applicabilities"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_append_only();

CREATE TRIGGER validation_finding_reference_dataset_versions_append_only_trg
  BEFORE UPDATE OR DELETE ON "validation_finding_reference_dataset_versions"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_append_only();

-- Owner-approved addition to §16: provenance belongs to the finding it was recorded with. A row may
-- only be inserted by the transaction that inserted its finding (the finding row's xmin is that
-- transaction, and A5.7 forbids updating it), so a committed finding — a system finding in
-- particular — can never later be given, or extended with, governed provenance.
CREATE OR REPLACE FUNCTION validation_provenance_same_transaction()
RETURNS TRIGGER AS $$
DECLARE
  finding_xmin xid;
BEGIN
  SELECT xmin INTO finding_xmin FROM "validation_findings" WHERE "id" = NEW."validation_finding_id";
  IF finding_xmin IS NOT NULL AND finding_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION '%: provenance can only be recorded with its own finding, never added later', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER validation_finding_rule_provenances_same_transaction_trg
  BEFORE INSERT ON "validation_finding_rule_provenances"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_same_transaction();

CREATE TRIGGER validation_finding_supporting_bindings_same_transaction_trg
  BEFORE INSERT ON "validation_finding_supporting_bindings"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_same_transaction();

CREATE TRIGGER validation_finding_matched_applicabilities_same_transaction_trg
  BEFORE INSERT ON "validation_finding_matched_applicabilities"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_same_transaction();

CREATE TRIGGER validation_finding_ref_dataset_versions_same_transaction_trg
  BEFORE INSERT ON "validation_finding_reference_dataset_versions"
  FOR EACH ROW EXECUTE FUNCTION validation_provenance_same_transaction();
