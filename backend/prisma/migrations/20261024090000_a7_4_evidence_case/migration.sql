-- A7.4 — Revenue Evidence Case Assembly & Provenance Snapshot
--
-- Creates exactly two append-only tables: evidence_case_snapshots (A7-REVENUE-CASE-1, one immutable header per
-- frozen submission and contract) and evidence_case_entries (its exact, ordered source/classification/readiness
-- references), with their indexes, CHECKs, insert guards, a commit-time completeness and manifest check, and
-- append-only and TRUNCATE triggers on both. No applied migration is modified, no existing table is altered, and the
-- generated statements below were produced schema-to-schema with no unrelated drift.
--
-- A case snapshot is a descriptive, as-recorded inventory. It is never an adjudication, external submission,
-- balance, settlement, collection or revenue closure, and never a current or latest pointer.
-- (Physical names kept clear of the A7.1 "revenue" table scans; the API keeps the business name.)

-- CreateTable
CREATE TABLE "evidence_case_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_submission_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "assembly_code" TEXT NOT NULL,
    "source_count" INTEGER NOT NULL,
    "classified_count" INTEGER NOT NULL,
    "readiness_count" INTEGER NOT NULL,
    "item_count" INTEGER NOT NULL,
    "manifest_sha256" CHAR(64) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_case_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_case_entries" (
    "id" UUID NOT NULL,
    "assembly_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "source_evidence_id" UUID NOT NULL,
    "classification_id" UUID,
    "readiness_id" UUID,
    "item_reason_code" TEXT NOT NULL,

    CONSTRAINT "evidence_case_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_case_snapshots_organization_id_idx" ON "evidence_case_snapshots"("organization_id");

-- CreateIndex
CREATE INDEX "evidence_case_snapshots_recorded_by_user_id_idx" ON "evidence_case_snapshots"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_case_snapshots_identity_key" ON "evidence_case_snapshots"("claim_submission_id", "contract_version");

-- CreateIndex
CREATE INDEX "evidence_case_entries_source_evidence_id_idx" ON "evidence_case_entries"("source_evidence_id");

-- CreateIndex
CREATE INDEX "evidence_case_entries_classification_id_idx" ON "evidence_case_entries"("classification_id");

-- CreateIndex
CREATE INDEX "evidence_case_entries_readiness_id_idx" ON "evidence_case_entries"("readiness_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_case_entries_ordinal_key" ON "evidence_case_entries"("assembly_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_case_entries_source_key" ON "evidence_case_entries"("assembly_id", "source_evidence_id");

-- AddForeignKey
ALTER TABLE "evidence_case_snapshots" ADD CONSTRAINT "evidence_case_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_case_snapshots" ADD CONSTRAINT "evidence_case_snapshots_claim_submission_id_fkey" FOREIGN KEY ("claim_submission_id") REFERENCES "claim_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_case_snapshots" ADD CONSTRAINT "evidence_case_snapshots_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_case_entries" ADD CONSTRAINT "evidence_case_entries_assembly_id_fkey" FOREIGN KEY ("assembly_id") REFERENCES "evidence_case_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_case_entries" ADD CONSTRAINT "evidence_case_entries_source_evidence_id_fkey" FOREIGN KEY ("source_evidence_id") REFERENCES "revenue_source_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_case_entries" ADD CONSTRAINT "evidence_case_entries_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "source_evidence_classifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_case_entries" ADD CONSTRAINT "evidence_case_entries_readiness_id_fkey" FOREIGN KEY ("readiness_id") REFERENCES "evidence_gate_results"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity (A7.4 §3, §4, §5) ---------------------------------------------------------

-- §3/§4 — the fixed contract, the controlled vocabularies and the counts, each NOT NULL explicitly (a NULL must
-- never pass an IN list). No amount, currency, payer, status, balance, ready or adjudicated value exists.
ALTER TABLE "evidence_case_snapshots"
  ADD CONSTRAINT "evidence_case_snapshots_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A7-REVENUE-CASE-1');

ALTER TABLE "evidence_case_snapshots"
  ADD CONSTRAINT "evidence_case_snapshots_code_chk" CHECK (
    "assembly_code" IS NOT NULL AND "assembly_code" IN ('INVENTORY_COMPLETE', 'INVENTORY_INCOMPLETE', 'NO_REVENUE_SOURCES')
  );

-- One entry per source; a readiness only exists for a classification.
ALTER TABLE "evidence_case_snapshots"
  ADD CONSTRAINT "evidence_case_snapshots_counts_chk" CHECK (
    "source_count" IS NOT NULL AND "classified_count" IS NOT NULL AND "readiness_count" IS NOT NULL AND "item_count" IS NOT NULL
    AND "item_count" >= 0 AND "source_count" = "item_count" AND "classified_count" BETWEEN 0 AND "item_count" AND "readiness_count" BETWEEN 0 AND "classified_count"
  );

-- The code is exactly what the counts say: no sources, every source linked, or some link missing.
ALTER TABLE "evidence_case_snapshots"
  ADD CONSTRAINT "evidence_case_snapshots_code_counts_chk" CHECK (
    ("assembly_code" = 'NO_REVENUE_SOURCES' AND "item_count" = 0)
    OR ("assembly_code" = 'INVENTORY_COMPLETE' AND "item_count" > 0 AND "readiness_count" = "item_count")
    OR ("assembly_code" = 'INVENTORY_INCOMPLETE' AND "item_count" > 0 AND "readiness_count" < "item_count")
  );

ALTER TABLE "evidence_case_snapshots"
  ADD CONSTRAINT "evidence_case_snapshots_manifest_chk" CHECK ("manifest_sha256" IS NOT NULL AND "manifest_sha256" ~ '^[0-9a-f]{64}$');

ALTER TABLE "evidence_case_entries"
  ADD CONSTRAINT "evidence_case_entries_ordinal_chk" CHECK ("ordinal" IS NOT NULL AND "ordinal" >= 1);

ALTER TABLE "evidence_case_entries"
  ADD CONSTRAINT "evidence_case_entries_reason_chk" CHECK (
    "item_reason_code" IS NOT NULL AND "item_reason_code" IN ('SOURCE_ONLY', 'CLASSIFIED_NO_READINESS', 'LINKED')
  );

-- The reason is exactly what the links say.
ALTER TABLE "evidence_case_entries"
  ADD CONSTRAINT "evidence_case_entries_shape_chk" CHECK (
    ("item_reason_code" = 'SOURCE_ONLY' AND "classification_id" IS NULL AND "readiness_id" IS NULL)
    OR ("item_reason_code" = 'CLASSIFIED_NO_READINESS' AND "classification_id" IS NOT NULL AND "readiness_id" IS NULL)
    OR ("item_reason_code" = 'LINKED' AND "classification_id" IS NOT NULL AND "readiness_id" IS NOT NULL)
  );

-- §4 — a snapshot header is recorded and created at the database's own transaction time and belongs to exactly the
-- organization that owns its frozen submission.
CREATE OR REPLACE FUNCTION evidence_case_snapshots_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  owning_organization uuid;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'evidence_case_snapshot_time: a case snapshot is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT p."organization_id" INTO owning_organization
  FROM "claim_freezes" f
  JOIN "claims" k ON k."id" = f."claim_id"
  JOIN "encounters" e ON e."id" = k."encounter_id"
  JOIN "patients" p ON p."id" = e."patient_id"
  WHERE f."id" = NEW."claim_submission_id";
  IF owning_organization IS NULL THEN
    RETURN NEW; -- the foreign key reports a missing frozen submission
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM owning_organization THEN
    RAISE EXCEPTION 'evidence_case_snapshot_coherence: the organization must be the one that owns the frozen submission'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_case_snapshots_insert_guard_trg
  BEFORE INSERT ON "evidence_case_snapshots"
  FOR EACH ROW EXECUTE FUNCTION evidence_case_snapshots_insert_guard();

-- §4 — an entry is written only in the transaction that created its header (no late entry), names a source of
-- exactly that frozen submission and organization, and names exactly the classification and readiness result the
-- owners recorded for it: NULL only when none exists (an entry may not claim a link is missing when it is not),
-- never another source's or another classification's. A linked readiness must be the classification's own (same
-- source, organization and copied fingerprint) and agree with its outcome; anything else is a provenance conflict.
-- Nothing is re-derived: the A7.2 classifier, its fingerprint and the A7.3 readiness are only read.
CREATE OR REPLACE FUNCTION evidence_case_entries_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  hdr RECORD;
  src RECORD;
  cls RECORD;
  gate RECORD;
  has_classification boolean;
  has_readiness boolean;
BEGIN
  SELECT h.* INTO hdr FROM "evidence_case_snapshots" h WHERE h."id" = NEW."assembly_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing header
  END IF;
  IF hdr."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'evidence_case_entry_late: entries are written only with their snapshot, in its own transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.* INTO src FROM "revenue_source_evidence" r WHERE r."id" = NEW."source_evidence_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing source
  END IF;
  IF src."claim_submission_id" IS DISTINCT FROM hdr."claim_submission_id" OR src."organization_id" IS DISTINCT FROM hdr."organization_id" THEN
    RAISE EXCEPTION 'evidence_case_entry_linkage: the source must belong to the snapshot''s frozen submission and organization'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT c.* INTO cls FROM "source_evidence_classifications" c WHERE c."source_evidence_id" = src."id" AND c."contract_version" = 'A7-EVIDENCE-CLASS-1';
  has_classification := FOUND;
  IF NEW."classification_id" IS NULL THEN
    IF has_classification THEN
      RAISE EXCEPTION 'evidence_case_entry_derivation: the source has a classification, so the entry may not record it as absent'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT has_classification OR cls."id" IS DISTINCT FROM NEW."classification_id" OR cls."organization_id" IS DISTINCT FROM hdr."organization_id" THEN
    RAISE EXCEPTION 'evidence_case_entry_linkage: the classification must be exactly the one recorded for this source'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT g.* INTO gate FROM "evidence_gate_results" g WHERE g."classification_id" = cls."id" AND g."contract_version" = 'A7-ADJ-READINESS-1';
  has_readiness := FOUND;
  IF NEW."readiness_id" IS NULL THEN
    IF has_readiness THEN
      RAISE EXCEPTION 'evidence_case_entry_derivation: the classification has a readiness result, so the entry may not record it as absent'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT has_readiness OR gate."id" IS DISTINCT FROM NEW."readiness_id" THEN
    RAISE EXCEPTION 'evidence_case_entry_linkage: the readiness must be exactly the one recorded for this classification'
      USING ERRCODE = 'check_violation';
  END IF;
  IF gate."source_evidence_id" IS DISTINCT FROM src."id" OR gate."organization_id" IS DISTINCT FROM hdr."organization_id"
     OR gate."classification_fingerprint_sha256" IS DISTINCT FROM cls."source_fingerprint_sha256"
     OR (cls."normalization_outcome", gate."readiness_code") NOT IN (
          ('CLASSIFIED', 'NOT_READY_FOR_ADJUDICATION'), ('NEEDS_REVIEW', 'SOURCE_REQUIRES_REVIEW'), ('UNSUPPORTED', 'SOURCE_UNSUPPORTED')) THEN
    RAISE EXCEPTION 'evidence_case_entry_conflict: the readiness result contradicts its classification; no case is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_case_entries_insert_guard_trg
  BEFORE INSERT ON "evidence_case_entries"
  FOR EACH ROW EXECUTE FUNCTION evidence_case_entries_insert_guard();

-- §4/§5 — checked once at COMMIT, after the header and all entries are written: the entries are exactly the frozen
-- submission's sources (no missing, extra or dangling one), numbered 1..N contiguously in (received_at, id) order;
-- the counts are exactly the rows; and the manifest digest is recomputed here from the stored typed fields:
--   SHA-256 of "SBN-A7-REVENUE-CASE-1\n" then the "name=value\n" lines contract, claimSubmissionId, organizationId,
--   assemblyCode, sourceCount, classifiedCount, readinessCount, itemCount, then for each entry in ordinal order one
--   line "item=<ordinal>|<sourceEvidenceId>|<classificationId or NULL>|<readinessId or NULL>|<itemReasonCode>".
CREATE OR REPLACE FUNCTION evidence_case_snapshots_completeness()
RETURNS TRIGGER AS $$
DECLARE
  hdr RECORD;
  entry_count integer;
  first_ordinal integer;
  last_ordinal integer;
  classified integer;
  linked integer;
  submission_sources integer;
  misordered integer;
  expected_manifest text;
BEGIN
  SELECT h.* INTO hdr FROM "evidence_case_snapshots" h WHERE h."id" = NEW."id";
  SELECT count(*), min(e."ordinal"), max(e."ordinal"), count(e."classification_id"), count(e."readiness_id")
    INTO entry_count, first_ordinal, last_ordinal, classified, linked
  FROM "evidence_case_entries" e WHERE e."assembly_id" = hdr."id";
  SELECT count(*) INTO submission_sources FROM "revenue_source_evidence" r WHERE r."claim_submission_id" = hdr."claim_submission_id";
  SELECT count(*) INTO misordered FROM (
    SELECT e."ordinal", row_number() OVER (ORDER BY r."received_at", r."id") AS position
    FROM "evidence_case_entries" e JOIN "revenue_source_evidence" r ON r."id" = e."source_evidence_id"
    WHERE e."assembly_id" = hdr."id"
  ) ranked WHERE ranked."ordinal" <> ranked."position";
  IF entry_count <> hdr."item_count" OR (entry_count > 0 AND (first_ordinal <> 1 OR last_ordinal <> entry_count))
     OR classified <> hdr."classified_count" OR linked <> hdr."readiness_count" OR submission_sources <> entry_count OR misordered <> 0 THEN
    RAISE EXCEPTION 'evidence_case_snapshot_incomplete: the entries must be exactly the frozen submission''s sources, numbered 1..N in received order, matching the counts'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT encode(sha256(convert_to(
    'SBN-A7-REVENUE-CASE-1' || chr(10) ||
    'contract=' || hdr."contract_version" || chr(10) ||
    'claimSubmissionId=' || hdr."claim_submission_id"::text || chr(10) ||
    'organizationId=' || hdr."organization_id"::text || chr(10) ||
    'assemblyCode=' || hdr."assembly_code" || chr(10) ||
    'sourceCount=' || hdr."source_count"::text || chr(10) ||
    'classifiedCount=' || hdr."classified_count"::text || chr(10) ||
    'readinessCount=' || hdr."readiness_count"::text || chr(10) ||
    'itemCount=' || hdr."item_count"::text || chr(10) ||
    coalesce((SELECT string_agg('item=' || e."ordinal"::text || '|' || e."source_evidence_id"::text || '|' || coalesce(e."classification_id"::text, 'NULL') || '|' || coalesce(e."readiness_id"::text, 'NULL') || '|' || e."item_reason_code" || chr(10), '' ORDER BY e."ordinal")
              FROM "evidence_case_entries" e WHERE e."assembly_id" = hdr."id"), ''),
    'UTF8')), 'hex') INTO expected_manifest;
  IF hdr."manifest_sha256" IS DISTINCT FROM expected_manifest THEN
    RAISE EXCEPTION 'evidence_case_snapshot_manifest: the manifest digest must be recomputed from the snapshot and its entries'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER evidence_case_snapshots_completeness_trg
  AFTER INSERT ON "evidence_case_snapshots"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION evidence_case_snapshots_completeness();

-- §4 — snapshots and entries are history: never updated (not even a no-op update), never deleted and never wiped in
-- bulk, on BOTH tables (a TRUNCATE ... CASCADE from either is refused).
CREATE OR REPLACE FUNCTION evidence_case_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_case_snapshots_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_case_snapshots"
  FOR EACH ROW EXECUTE FUNCTION evidence_case_append_only();

CREATE TRIGGER evidence_case_snapshots_no_truncate_trg
  BEFORE TRUNCATE ON "evidence_case_snapshots"
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_case_append_only();

CREATE TRIGGER evidence_case_entries_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_case_entries"
  FOR EACH ROW EXECUTE FUNCTION evidence_case_append_only();

CREATE TRIGGER evidence_case_entries_no_truncate_trg
  BEFORE TRUNCATE ON "evidence_case_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_case_append_only();

-- There is deliberately no amount, currency, payer, status, balance, ready/adjudicated/paid/denied label, current or
-- latest pointer, no stored canonical bytes, and no new column on any A6, A7.1, A7.2 or A7.3 table.
