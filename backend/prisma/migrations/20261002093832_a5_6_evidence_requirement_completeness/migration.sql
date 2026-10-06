-- A5.6 — Evidence Requirement Resolution & Completeness
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A5.6 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly three
-- tables and touches nothing else.
--
-- Note on evaluation: there is deliberately no completeness-result table. Completeness is computed
-- read-only every time it is asked for; ValidationRun/ValidationFinding persistence is A5.7's.

-- CreateTable
CREATE TABLE "evidence_requirements" (
    "id" UUID NOT NULL,
    "rule_version_id" UUID NOT NULL,
    "minimum_count" INTEGER NOT NULL DEFAULT 1,
    "source_date_required" BOOLEAN NOT NULL DEFAULT false,
    "max_source_age_days" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_requirement_document_types" (
    "id" UUID NOT NULL,
    "evidence_requirement_id" UUID NOT NULL,
    "document_type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_requirement_document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "encounter_evidence_links" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "evidence_artifact_version_id" UUID NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "evidence_requirements_rule_version_id_key" ON "evidence_requirements"("rule_version_id");

-- CreateIndex
CREATE INDEX "evidence_requirements_rule_version_id_idx" ON "evidence_requirements"("rule_version_id");

-- CreateIndex
CREATE INDEX "evidence_requirement_document_types_evidence_requirement_id_idx" ON "evidence_requirement_document_types"("evidence_requirement_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_requirement_document_types_evidence_requirement_id_key" ON "evidence_requirement_document_types"("evidence_requirement_id", "document_type");

-- CreateIndex
CREATE INDEX "encounter_evidence_links_encounter_id_idx" ON "encounter_evidence_links"("encounter_id");

-- CreateIndex
CREATE INDEX "encounter_evidence_links_evidence_artifact_version_id_idx" ON "encounter_evidence_links"("evidence_artifact_version_id");

-- CreateIndex
CREATE INDEX "encounter_evidence_links_encounter_id_removed_at_idx" ON "encounter_evidence_links"("encounter_id", "removed_at");

-- AddForeignKey
ALTER TABLE "evidence_requirements" ADD CONSTRAINT "evidence_requirements_rule_version_id_fkey" FOREIGN KEY ("rule_version_id") REFERENCES "rule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_requirement_document_types" ADD CONSTRAINT "evidence_requirement_document_types_evidence_requirement_i_fkey" FOREIGN KEY ("evidence_requirement_id") REFERENCES "evidence_requirements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_evidence_links" ADD CONSTRAINT "encounter_evidence_links_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_evidence_links" ADD CONSTRAINT "encounter_evidence_links_evidence_artifact_version_id_fkey" FOREIGN KEY ("evidence_artifact_version_id") REFERENCES "evidence_artifact_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "encounter_evidence_links" ADD CONSTRAINT "encounter_evidence_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.6 §19 — requirement invariants are held by the database, not only by application validation.
ALTER TABLE "evidence_requirements"
  ADD CONSTRAINT "evidence_requirements_minimum_count_chk" CHECK ("minimum_count" >= 1);

ALTER TABLE "evidence_requirements"
  ADD CONSTRAINT "evidence_requirements_max_source_age_nonnegative_chk" CHECK ("max_source_age_days" IS NULL OR "max_source_age_days" >= 0);

-- A freshness limit cannot be judged without a source date, so it requires one.
ALTER TABLE "evidence_requirements"
  ADD CONSTRAINT "evidence_requirements_freshness_requires_date_chk" CHECK ("max_source_age_days" IS NULL OR "source_date_required");

-- An opaque label, stored trimmed and nonblank, with its case preserved.
ALTER TABLE "evidence_requirement_document_types"
  ADD CONSTRAINT "evidence_requirement_document_types_document_type_chk" CHECK (btrim("document_type") <> '' AND "document_type" = btrim("document_type"));

-- One ACTIVE link per Encounter and exact evidence version. A removed link stays as history, so
-- re-linking the same version later is a new row.
CREATE UNIQUE INDEX "encounter_evidence_links_active_uq" ON "encounter_evidence_links"("encounter_id", "evidence_artifact_version_id") WHERE "removed_at" IS NULL;

-- A5.6 §4/§5 — a requirement and its document types are immutable once created. Correcting one
-- means a new RuleVersion with a new payload, so the database refuses both operations for every
-- writer, including a direct SQL session. This follows the A5.1-A5.4 append-only triggers.
CREATE OR REPLACE FUNCTION evidence_requirements_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'evidence_requirements is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_requirements_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_requirements"
  FOR EACH ROW EXECUTE FUNCTION evidence_requirements_append_only();

CREATE OR REPLACE FUNCTION evidence_requirement_document_types_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'evidence_requirement_document_types is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_requirement_document_types_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_requirement_document_types"
  FOR EACH ROW EXECUTE FUNCTION evidence_requirement_document_types_append_only();

-- A5.6 §7/§19 — an evidence link is corrected only by removing it, once. Its identity never changes,
-- a removed link is never reactivated or re-stamped, and no link is ever deleted.
CREATE OR REPLACE FUNCTION encounter_evidence_links_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'encounter_evidence_links cannot be deleted; remove the link instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."encounter_id" IS DISTINCT FROM OLD."encounter_id"
     OR NEW."evidence_artifact_version_id" IS DISTINCT FROM OLD."evidence_artifact_version_id"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'encounter_evidence_links identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'encounter_evidence_links: a removed link cannot be changed or reactivated'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."removed_at" IS NULL THEN
    RAISE EXCEPTION 'encounter_evidence_links: the only permitted change is setting removed_at once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER encounter_evidence_links_guard_trg
  BEFORE UPDATE OR DELETE ON "encounter_evidence_links"
  FOR EACH ROW EXECUTE FUNCTION encounter_evidence_links_guard();
