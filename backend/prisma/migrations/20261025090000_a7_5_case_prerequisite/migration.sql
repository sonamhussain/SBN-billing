-- A7.5 — Revenue Case Closure-Prerequisite Assessment
--
-- Creates exactly one append-only table: evidence_prereq_results (A7-CLOSURE-PREREQ-1, one immutable assessment per
-- exact A7.4 case snapshot and contract), with its indexes, CHECKs, an insert guard that re-derives the outcome from
-- the stored case, and append-only and TRUNCATE triggers. No applied migration is modified, no existing table is
-- altered, and the generated statements below were produced schema-to-schema with no unrelated drift.
--
-- An assessment states why the prerequisites of a later financial closure are ABSENT for one case. It is never an
-- adjudication, payment, posting, reconciliation, balance or closure, and never a current or latest pointer.
-- (Physical name kept clear of the A7.1 "revenue", A7.4 "case" and A7.4 "closure" table scans; the API keeps the
-- business name. No item-copy table: the immutable A7.4 entries remain the source of item detail.)

-- CreateTable
CREATE TABLE "evidence_prereq_results" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "evidence_case_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "assessment_code" TEXT NOT NULL,
    "basis_code" TEXT NOT NULL,
    "case_manifest_sha256" CHAR(64) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_prereq_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_prereq_results_organization_id_idx" ON "evidence_prereq_results"("organization_id");

-- CreateIndex
CREATE INDEX "evidence_prereq_results_recorded_by_user_id_idx" ON "evidence_prereq_results"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_prereq_results_identity_key" ON "evidence_prereq_results"("evidence_case_id", "contract_version");

-- AddForeignKey
ALTER TABLE "evidence_prereq_results" ADD CONSTRAINT "evidence_prereq_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_prereq_results" ADD CONSTRAINT "evidence_prereq_results_evidence_case_id_fkey" FOREIGN KEY ("evidence_case_id") REFERENCES "evidence_case_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_prereq_results" ADD CONSTRAINT "evidence_prereq_results_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity (A7.5 §3, §4) --------------------------------------------------------------

-- §4 — the fixed contract, the five controlled outcomes, the five bases and their exact 1:1 pairing, and the digest
-- shape, each NOT NULL explicitly (a NULL must never pass an IN list). No ready, closed, paid, settled or posted
-- value exists, and no amount, currency, payer, status or balance column.
ALTER TABLE "evidence_prereq_results"
  ADD CONSTRAINT "evidence_prereq_results_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A7-CLOSURE-PREREQ-1');

ALTER TABLE "evidence_prereq_results"
  ADD CONSTRAINT "evidence_prereq_results_code_chk" CHECK (
    "assessment_code" IS NOT NULL AND "assessment_code" IN ('NO_SOURCE_BASIS', 'INCOMPLETE_SOURCE_CHAIN', 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT', 'REVIEW_REQUIRED', 'UNSUPPORTED_SOURCE_BASIS')
  );

ALTER TABLE "evidence_prereq_results"
  ADD CONSTRAINT "evidence_prereq_results_basis_chk" CHECK (
    "basis_code" IS NOT NULL AND "basis_code" IN ('NO_REGISTERED_SOURCES', 'SOURCE_LINKS_INCOMPLETE', 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED', 'EVIDENCE_REVIEW_REQUIRED', 'UNSUPPORTED_EVIDENCE')
  );

ALTER TABLE "evidence_prereq_results"
  ADD CONSTRAINT "evidence_prereq_results_pairing_chk" CHECK (
    ("assessment_code" = 'NO_SOURCE_BASIS' AND "basis_code" = 'NO_REGISTERED_SOURCES')
    OR ("assessment_code" = 'INCOMPLETE_SOURCE_CHAIN' AND "basis_code" = 'SOURCE_LINKS_INCOMPLETE')
    OR ("assessment_code" = 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' AND "basis_code" = 'EXTERNAL_REMITTANCE_NOT_ESTABLISHED')
    OR ("assessment_code" = 'REVIEW_REQUIRED' AND "basis_code" = 'EVIDENCE_REVIEW_REQUIRED')
    OR ("assessment_code" = 'UNSUPPORTED_SOURCE_BASIS' AND "basis_code" = 'UNSUPPORTED_EVIDENCE')
  );

ALTER TABLE "evidence_prereq_results"
  ADD CONSTRAINT "evidence_prereq_results_digest_chk" CHECK ("case_manifest_sha256" IS NOT NULL AND "case_manifest_sha256" ~ '^[0-9a-f]{64}$');

-- §4 — an assessment is recorded and created at the database's own transaction time; belongs to exactly the
-- organization of its case, which must also own the case's frozen submission (Claim -> Encounter -> Patient);
-- carries the case's stored manifest digest, copied, never recomputed; and states exactly the outcome re-derived here
-- from the STORED case header, its entries and the stored A7.3 readiness each linked entry names. A case that
-- contradicts A7-REVENUE-CASE-1 (another contract, entry counts that disagree with the header, a linked readiness that
-- is missing, of another classification, source or contract, or not an approved readiness/reason pair, or a code
-- that disagrees with its entries) is a provenance conflict: nothing is recorded for it.
--   priority: NO_REVENUE_SOURCES -> NO_SOURCE_BASIS; INVENTORY_INCOMPLETE -> INCOMPLETE_SOURCE_CHAIN; a complete
--   case with any SOURCE_REQUIRES_REVIEW -> REVIEW_REQUIRED; else with any SOURCE_UNSUPPORTED ->
--   UNSUPPORTED_SOURCE_BASIS; else (every readiness NOT_READY_FOR_ADJUDICATION) -> EXTERNAL_FINANCIAL_EVIDENCE_ABSENT.
-- The basis follows from the outcome through the pairing CHECK.
CREATE OR REPLACE FUNCTION evidence_prereq_results_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  hdr RECORD;
  owning_organization uuid;
  entry_count integer;
  linked_count integer;
  broken integer;
  reviews integer;
  unsupported integer;
  derived text;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'evidence_prereq_time: an assessment is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT h.* INTO hdr FROM "evidence_case_snapshots" h WHERE h."id" = NEW."evidence_case_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing case
  END IF;
  SELECT p."organization_id" INTO owning_organization
  FROM "claim_freezes" f
  JOIN "claims" k ON k."id" = f."claim_id"
  JOIN "encounters" e ON e."id" = k."encounter_id"
  JOIN "patients" p ON p."id" = e."patient_id"
  WHERE f."id" = hdr."claim_submission_id";
  IF NEW."organization_id" IS DISTINCT FROM hdr."organization_id" OR NEW."organization_id" IS DISTINCT FROM owning_organization THEN
    RAISE EXCEPTION 'evidence_prereq_coherence: the organization must be the one that owns the case and its frozen submission'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."case_manifest_sha256" IS DISTINCT FROM hdr."manifest_sha256" THEN
    RAISE EXCEPTION 'evidence_prereq_digest: the case digest must be copied exactly from the stored case'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*), count(e."readiness_id") INTO entry_count, linked_count
  FROM "evidence_case_entries" e WHERE e."assembly_id" = hdr."id";
  SELECT count(*) INTO broken
  FROM "evidence_case_entries" e
  LEFT JOIN "evidence_gate_results" g ON g."id" = e."readiness_id"
  WHERE e."assembly_id" = hdr."id" AND e."readiness_id" IS NOT NULL
    AND (g."id" IS NULL
         OR g."contract_version" IS DISTINCT FROM 'A7-ADJ-READINESS-1'
         OR g."classification_id" IS DISTINCT FROM e."classification_id"
         OR g."source_evidence_id" IS DISTINCT FROM e."source_evidence_id"
         OR NOT coalesce((g."readiness_code", g."reason_code") IN (
              ('NOT_READY_FOR_ADJUDICATION', 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT'),
              ('SOURCE_REQUIRES_REVIEW', 'CLASSIFICATION_REVIEW_REQUIRED'),
              ('SOURCE_UNSUPPORTED', 'CLASSIFICATION_UNSUPPORTED')), false));
  SELECT count(*) FILTER (WHERE g."readiness_code" = 'SOURCE_REQUIRES_REVIEW'), count(*) FILTER (WHERE g."readiness_code" = 'SOURCE_UNSUPPORTED')
    INTO reviews, unsupported
  FROM "evidence_case_entries" e JOIN "evidence_gate_results" g ON g."id" = e."readiness_id"
  WHERE e."assembly_id" = hdr."id";
  derived := CASE
    WHEN hdr."contract_version" IS DISTINCT FROM 'A7-REVENUE-CASE-1' OR entry_count <> hdr."item_count" OR linked_count <> hdr."readiness_count" OR broken <> 0 THEN NULL
    WHEN hdr."assembly_code" = 'NO_REVENUE_SOURCES' AND entry_count = 0 THEN 'NO_SOURCE_BASIS'
    WHEN hdr."assembly_code" = 'INVENTORY_INCOMPLETE' AND entry_count > 0 AND linked_count < entry_count THEN 'INCOMPLETE_SOURCE_CHAIN'
    WHEN hdr."assembly_code" = 'INVENTORY_COMPLETE' AND entry_count > 0 AND linked_count = entry_count THEN
      CASE WHEN reviews > 0 THEN 'REVIEW_REQUIRED' WHEN unsupported > 0 THEN 'UNSUPPORTED_SOURCE_BASIS' ELSE 'EXTERNAL_FINANCIAL_EVIDENCE_ABSENT' END
    ELSE NULL
  END;
  IF derived IS NULL THEN
    RAISE EXCEPTION 'evidence_prereq_conflict: the case contradicts A7-REVENUE-CASE-1; no assessment is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."assessment_code" IS DISTINCT FROM derived THEN
    RAISE EXCEPTION 'evidence_prereq_derivation: the assessment must be exactly the one derived from the stored case'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_prereq_results_insert_guard_trg
  BEFORE INSERT ON "evidence_prereq_results"
  FOR EACH ROW EXECUTE FUNCTION evidence_prereq_results_insert_guard();

-- §4 — assessments are history: never updated (not even a no-op update), never deleted and never wiped in bulk (a
-- TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION evidence_prereq_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_prereq_results_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_prereq_results"
  FOR EACH ROW EXECUTE FUNCTION evidence_prereq_append_only();

CREATE TRIGGER evidence_prereq_results_no_truncate_trg
  BEFORE TRUNCATE ON "evidence_prereq_results"
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_prereq_append_only();

-- There is deliberately no amount, currency, payer, status, balance, ready/closed/paid label, current or latest
-- pointer, no stored canonical bytes, no item-copy table and no new column on any A6 or A7.1–A7.4 table.
