-- CRG-01 FINAL, Checkpoint A — Medical Coding Release Governance foundation (CRG-CODESET-1)
--
-- Creates exactly five append-only, CRG-owned tables beside the reused A3 reference-dataset model:
-- crg_code_system_datasets (a dataset's code system and purpose), crg_code_system_rights (numbered rights decisions
-- per jurisdiction, authority and code system), crg_release_imports (one complete import per edition, bound to the
-- edition's content hash), crg_release_code_memberships (the immutable code membership of an edition) and
-- crg_retirement_classifications (what a RETIRED edition's retirement means). Each has RESTRICT foreign keys, unique
-- keys, CHECKs, an insert guard (database time and the coherence of each record with its A3 parent) and append-only
-- and TRUNCATE triggers; a deferred constraint trigger refuses any import whose rows do not reproduce its declared
-- count and SHA-256 at commit. No applied migration is modified, no existing table is altered, and the generated
-- statements below were produced schema-to-schema with no unrelated drift.
--
-- This is Checkpoint A only: it imports no licensed catalogue, stores no descriptor text, blocks no claim and changes
-- no encounter, A2 master code, A3 dataset or version, validation finding or frozen claim.

-- CreateTable
CREATE TABLE "crg_code_system_datasets" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "code_system" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "authority_code" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_code_system_datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crg_code_system_rights" (
    "id" UUID NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "authority_code" TEXT NOT NULL,
    "code_system" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "rights_status" TEXT NOT NULL,
    "decision_reference" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_code_system_rights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crg_release_imports" (
    "id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "code_system" TEXT NOT NULL,
    "source_file_sha256" TEXT NOT NULL,
    "source_uri" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "expected_row_count" INTEGER NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_release_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crg_release_code_memberships" (
    "id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "code_system" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "source_row_id" TEXT NOT NULL,
    "source_row_sha256" TEXT NOT NULL,
    "release_content_hash" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_release_code_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crg_retirement_classifications" (
    "id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "classification" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_retirement_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crg_code_system_datasets_dataset_key" ON "crg_code_system_datasets"("dataset_id");

-- CreateIndex
CREATE UNIQUE INDEX "crg_code_system_rights_sequence_key" ON "crg_code_system_rights"("jurisdiction_code", "authority_code", "code_system", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "crg_release_imports_version_key" ON "crg_release_imports"("dataset_version_id");

-- CreateIndex
CREATE INDEX "crg_release_code_memberships_import_id_idx" ON "crg_release_code_memberships"("import_id");

-- CreateIndex
CREATE UNIQUE INDEX "crg_release_code_memberships_code_key" ON "crg_release_code_memberships"("dataset_version_id", "code_system", "code");

-- CreateIndex
CREATE UNIQUE INDEX "crg_release_code_memberships_row_key" ON "crg_release_code_memberships"("import_id", "source_row_id");

-- CreateIndex
CREATE UNIQUE INDEX "crg_retirement_classifications_version_key" ON "crg_retirement_classifications"("dataset_version_id");

-- AddForeignKey
ALTER TABLE "crg_code_system_datasets" ADD CONSTRAINT "crg_code_system_datasets_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "reference_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crg_release_imports" ADD CONSTRAINT "crg_release_imports_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crg_release_code_memberships" ADD CONSTRAINT "crg_release_code_memberships_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "crg_release_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crg_release_code_memberships" ADD CONSTRAINT "crg_release_code_memberships_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crg_retirement_classifications" ADD CONSTRAINT "crg_retirement_classifications_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (CRG-01 FINAL §4.1, §4.2) --------------------------------------------------------------

-- The fixed contract, the controlled code systems (DHA GC 06-2026, register clause C1), purposes, rights statuses,
-- retirement classifications, canonical codes, source row ids and lower-case SHA-256 fingerprints. Each NOT NULL
-- explicitly (a NULL must never pass an IN list or a pattern).
ALTER TABLE "crg_code_system_datasets"
  ADD CONSTRAINT "crg_code_system_datasets_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'CRG-CODESET-1'),
  ADD CONSTRAINT "crg_code_system_datasets_code_system_chk" CHECK ("code_system" IS NOT NULL AND "code_system" IN ('ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II')),
  ADD CONSTRAINT "crg_code_system_datasets_purpose_chk" CHECK ("purpose" IS NOT NULL AND "purpose" IN ('CLAIM_CODING'));

ALTER TABLE "crg_code_system_rights"
  ADD CONSTRAINT "crg_code_system_rights_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'CRG-CODESET-1'),
  ADD CONSTRAINT "crg_code_system_rights_code_system_chk" CHECK ("code_system" IS NOT NULL AND "code_system" IN ('ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II')),
  ADD CONSTRAINT "crg_code_system_rights_status_chk" CHECK ("rights_status" IS NOT NULL AND "rights_status" IN ('APPROVED', 'BLOCKED')),
  ADD CONSTRAINT "crg_code_system_rights_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1),
  ADD CONSTRAINT "crg_code_system_rights_scope_chk" CHECK (
    "jurisdiction_code" IS NOT NULL AND "jurisdiction_code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
    AND "authority_code" IS NOT NULL AND "authority_code" ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
  ),
  ADD CONSTRAINT "crg_code_system_rights_reference_chk" CHECK ("decision_reference" IS NOT NULL AND length(btrim("decision_reference")) BETWEEN 1 AND 200);

ALTER TABLE "crg_release_imports"
  ADD CONSTRAINT "crg_release_imports_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'CRG-CODESET-1'),
  ADD CONSTRAINT "crg_release_imports_code_system_chk" CHECK ("code_system" IS NOT NULL AND "code_system" IN ('ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II')),
  ADD CONSTRAINT "crg_release_imports_fingerprint_chk" CHECK ("source_file_sha256" IS NOT NULL AND "source_file_sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "crg_release_imports_source_chk" CHECK (
    "source_uri" IS NOT NULL AND "source_uri" ~ '^(https://|synthetic:)' AND length("source_uri") <= 500
    AND "publisher" IS NOT NULL AND length(btrim("publisher")) BETWEEN 1 AND 120
  ),
  ADD CONSTRAINT "crg_release_imports_row_count_chk" CHECK ("expected_row_count" IS NOT NULL AND "expected_row_count" BETWEEN 1 AND 5000);

ALTER TABLE "crg_release_code_memberships"
  ADD CONSTRAINT "crg_release_code_memberships_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'CRG-CODESET-1'),
  ADD CONSTRAINT "crg_release_code_memberships_code_system_chk" CHECK ("code_system" IS NOT NULL AND "code_system" IN ('ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II')),
  ADD CONSTRAINT "crg_release_code_memberships_code_chk" CHECK ("code" IS NOT NULL AND "code" ~ '^[A-Z0-9][A-Z0-9.-]{0,31}$'),
  ADD CONSTRAINT "crg_release_code_memberships_row_chk" CHECK ("source_row_id" IS NOT NULL AND "source_row_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$'),
  ADD CONSTRAINT "crg_release_code_memberships_fingerprint_chk" CHECK (
    "source_row_sha256" IS NOT NULL AND "source_row_sha256" ~ '^[0-9a-f]{64}$' AND "release_content_hash" IS NOT NULL AND "release_content_hash" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "crg_retirement_classifications"
  ADD CONSTRAINT "crg_retirement_classifications_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'CRG-CODESET-1'),
  ADD CONSTRAINT "crg_retirement_classifications_value_chk" CHECK ("classification" IS NOT NULL AND "classification" IN ('PROSPECTIVE', 'HISTORICALLY_INVALIDATED'));

-- A mapping is recorded at the database's own time, and its jurisdiction and authority are exactly its dataset's.
CREATE OR REPLACE FUNCTION crg_code_system_datasets_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  dataset RECORD;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_time: a CRG record is written at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  SELECT d."jurisdiction_code", d."authority_code" INTO dataset FROM "reference_datasets" d WHERE d."id" = NEW."dataset_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing dataset
  END IF;
  IF NEW."jurisdiction_code" IS DISTINCT FROM dataset."jurisdiction_code" OR NEW."authority_code" IS DISTINCT FROM dataset."authority_code" THEN
    RAISE EXCEPTION 'crg_mapping: a code-system mapping carries exactly its dataset''s jurisdiction and authority' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_code_system_datasets_insert_guard_trg BEFORE INSERT ON "crg_code_system_datasets" FOR EACH ROW EXECUTE FUNCTION crg_code_system_datasets_insert_guard();

-- A rights decision is recorded at the database's own time and numbered exactly one more than the decisions already
-- stored for its jurisdiction, authority and code system.
CREATE OR REPLACE FUNCTION crg_code_system_rights_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  expected integer;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_time: a CRG record is written at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(max(r."sequence"), 0) + 1 INTO expected FROM "crg_code_system_rights" r
  WHERE r."jurisdiction_code" = NEW."jurisdiction_code" AND r."authority_code" = NEW."authority_code" AND r."code_system" = NEW."code_system";
  IF NEW."sequence" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'crg_rights_sequence: the next rights decision of this scope is number %', expected USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_code_system_rights_insert_guard_trg BEFORE INSERT ON "crg_code_system_rights" FOR EACH ROW EXECUTE FUNCTION crg_code_system_rights_insert_guard();

-- An import is recorded at the database's own time, for an edition whose dataset is mapped to exactly its code system,
-- whose content hash is exactly the source file's SHA-256, and which has never been validated or activated (an
-- activated release never changes meaning).
CREATE OR REPLACE FUNCTION crg_release_imports_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  edition RECORD;
  mapped text;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_time: a CRG record is written at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."dataset_id", v."validation_status", v."activation_status", v."content_hash" INTO edition FROM "reference_dataset_versions" v WHERE v."id" = NEW."dataset_version_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing edition
  END IF;
  SELECT m."code_system" INTO mapped FROM "crg_code_system_datasets" m WHERE m."dataset_id" = edition."dataset_id";
  IF mapped IS NULL OR mapped IS DISTINCT FROM NEW."code_system" THEN
    RAISE EXCEPTION 'crg_import_system: an import carries exactly the code system its edition''s dataset is mapped to' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."source_file_sha256" IS DISTINCT FROM edition."content_hash" THEN
    RAISE EXCEPTION 'crg_import_hash: the source file SHA-256 must equal the edition''s content hash' USING ERRCODE = 'check_violation';
  END IF;
  IF edition."validation_status" IS DISTINCT FROM 'UNVALIDATED' OR edition."activation_status" IS DISTINCT FROM 'INACTIVE' OR EXISTS (
    SELECT 1 FROM "reference_dataset_lifecycle_events" e
    WHERE e."dataset_version_id" = NEW."dataset_version_id" AND (e."next_validation_status" = 'VALIDATED' OR e."action" IN ('ACTIVATE', 'ROLLBACK'))
  ) THEN
    RAISE EXCEPTION 'crg_sealed: an edition that has been validated or activated cannot be imported' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_release_imports_insert_guard_trg BEFORE INSERT ON "crg_release_imports" FOR EACH ROW EXECUTE FUNCTION crg_release_imports_insert_guard();

-- At commit, an import holds exactly its declared number of rows and their content fingerprint (SHA-256 over
-- `source_row_id TAB code TAB source_row_sha256 LF`, ordered by source row id) is exactly its source file SHA-256.
-- A partial, padded or altered import never commits.
CREATE OR REPLACE FUNCTION crg_release_imports_complete()
RETURNS TRIGGER AS $$
DECLARE
  stored integer;
  fingerprint text;
BEGIN
  SELECT count(*), encode(sha256(convert_to(coalesce(string_agg(m."source_row_id" || E'\t' || m."code" || E'\t' || m."source_row_sha256" || E'\n', '' ORDER BY m."source_row_id" COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO stored, fingerprint
  FROM "crg_release_code_memberships" m WHERE m."import_id" = NEW."id";
  IF stored IS DISTINCT FROM NEW."expected_row_count" THEN
    RAISE EXCEPTION 'crg_import_incomplete: the import holds % rows, not the declared %', stored, NEW."expected_row_count" USING ERRCODE = 'check_violation';
  END IF;
  IF fingerprint IS DISTINCT FROM NEW."source_file_sha256" THEN
    RAISE EXCEPTION 'crg_import_hash: the imported rows do not reproduce the source file SHA-256' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER crg_release_imports_complete_trg AFTER INSERT ON "crg_release_imports" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crg_release_imports_complete();

-- A membership row is recorded at the database's own time, in the same transaction as its import (no row is ever
-- added later), for the import's own edition and code system, with the edition's content hash as its release
-- checksum, and never beyond the import's declared row count.
CREATE OR REPLACE FUNCTION crg_release_code_memberships_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  parent RECORD;
  release_hash text;
  stored integer;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_time: a CRG record is written at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."dataset_version_id", i."code_system", i."expected_row_count", i."recorded_at" INTO parent FROM "crg_release_imports" i WHERE i."id" = NEW."import_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing import
  END IF;
  IF parent."recorded_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_import_closed: membership rows are written only in their import''s own transaction' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."dataset_version_id" IS DISTINCT FROM parent."dataset_version_id" OR NEW."code_system" IS DISTINCT FROM parent."code_system" THEN
    RAISE EXCEPTION 'crg_membership: a membership row carries exactly its import''s edition and code system' USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."content_hash" INTO release_hash FROM "reference_dataset_versions" v WHERE v."id" = NEW."dataset_version_id";
  IF NEW."release_content_hash" IS DISTINCT FROM release_hash THEN
    RAISE EXCEPTION 'crg_membership: a membership row''s release checksum is exactly its edition''s content hash' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO stored FROM "crg_release_code_memberships" m WHERE m."import_id" = NEW."import_id";
  IF stored >= parent."expected_row_count" THEN
    RAISE EXCEPTION 'crg_import_incomplete: the import already holds its declared % rows', parent."expected_row_count" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_release_code_memberships_insert_guard_trg BEFORE INSERT ON "crg_release_code_memberships" FOR EACH ROW EXECUTE FUNCTION crg_release_code_memberships_insert_guard();

-- A retirement classification is recorded at the database's own time, once, for an edition A3 has RETIRED.
CREATE OR REPLACE FUNCTION crg_retirement_classifications_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  state text;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_time: a CRG record is written at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  SELECT v."activation_status" INTO state FROM "reference_dataset_versions" v WHERE v."id" = NEW."dataset_version_id";
  IF FOUND AND state IS DISTINCT FROM 'RETIRED' THEN
    RAISE EXCEPTION 'crg_retirement: only a RETIRED edition is classified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_retirement_classifications_insert_guard_trg BEFORE INSERT ON "crg_retirement_classifications" FOR EACH ROW EXECUTE FUNCTION crg_retirement_classifications_insert_guard();

-- Every CRG table is history: never updated (not even a no-op update), never deleted and never wiped in bulk.
CREATE OR REPLACE FUNCTION crg_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_code_system_datasets_append_only_trg BEFORE UPDATE OR DELETE ON "crg_code_system_datasets" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_code_system_datasets_no_truncate_trg BEFORE TRUNCATE ON "crg_code_system_datasets" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_code_system_rights_append_only_trg BEFORE UPDATE OR DELETE ON "crg_code_system_rights" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_code_system_rights_no_truncate_trg BEFORE TRUNCATE ON "crg_code_system_rights" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_release_imports_append_only_trg BEFORE UPDATE OR DELETE ON "crg_release_imports" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_release_imports_no_truncate_trg BEFORE TRUNCATE ON "crg_release_imports" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_release_code_memberships_append_only_trg BEFORE UPDATE OR DELETE ON "crg_release_code_memberships" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_release_code_memberships_no_truncate_trg BEFORE TRUNCATE ON "crg_release_code_memberships" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_retirement_classifications_append_only_trg BEFORE UPDATE OR DELETE ON "crg_retirement_classifications" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_retirement_classifications_no_truncate_trg BEFORE TRUNCATE ON "crg_retirement_classifications" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();

-- There is deliberately no descriptor text, licensed content, current/latest pointer, catalogue status, claim block,
-- price, DRG or payer column, no A2 master reference, and no new column on any A1–A8 table.
