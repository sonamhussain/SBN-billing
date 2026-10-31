-- A8.1 — Exception Intake & Provenance Registry
--
-- Creates exactly one append-only table: exception_intake_records (A8-EXCEPTION-INTAKE-1, one immutable exception
-- intake per deterministic identity), with its indexes, CHECKs, an insert guard that holds database time, the owning
-- organization, the acting member, the exact source record, the specific owner-backed basis of its reason and the
-- identity digest, and append-only and TRUNCATE triggers. No applied migration is modified, no existing table is altered, and the generated statements below were
-- produced schema-to-schema with no unrelated drift.
--
-- An intake records that one exact source record of an accepted owner carries an exception its owner established. It
-- is never a payer verdict, denial, payment, balance, closure, assignment, status or resolution, and it stores no PHI,
-- payload, amount, payer detail, owner message or free text.

-- CreateTable
CREATE TABLE "exception_intake_records" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_record_id" UUID NOT NULL,
    "source_contract_version" TEXT NOT NULL,
    "source_fingerprint_sha256" CHAR(64),
    "exception_reason_code" TEXT NOT NULL,
    "basis_code" TEXT NOT NULL,
    "basis_record_id" UUID NOT NULL,
    "identity_key" CHAR(64) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_intake_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_intake_records_claim_id_recorded_at_id_idx" ON "exception_intake_records"("claim_id", "recorded_at", "id");

-- CreateIndex
CREATE INDEX "exception_intake_records_organization_id_idx" ON "exception_intake_records"("organization_id");

-- CreateIndex
CREATE INDEX "exception_intake_records_recorded_by_user_id_idx" ON "exception_intake_records"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_intake_records_identity_key" ON "exception_intake_records"("identity_key");

-- AddForeignKey
ALTER TABLE "exception_intake_records" ADD CONSTRAINT "exception_intake_records_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_intake_records" ADD CONSTRAINT "exception_intake_records_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_intake_records" ADD CONSTRAINT "exception_intake_records_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity (A8.1 §4, §6) --------------------------------------------------------------

-- §4 — the fixed contract, the two accepted source kinds each with its one source contract, the five controlled
-- reasons and the only (kind, reason) pairs an owner can establish, the digest shapes, each NOT NULL explicitly (a
-- NULL must never pass an IN list). SOURCE_REFERENCE_UNAVAILABLE and CONTRACT_VERSION_UNSUPPORTED are controlled
-- vocabulary that no accepted owner can establish today, so no pair admits them.
ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-EXCEPTION-INTAKE-1');

ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_source_kind_chk" CHECK (
    ("source_kind" = 'REVENUE_TIMELINE' AND "source_contract_version" = 'A7-REVENUE-TIMELINE-1')
    OR ("source_kind" = 'CLOSURE_PREREQUISITE_ASSESSMENT' AND "source_contract_version" = 'A7-CLOSURE-PREREQ-1')
  );

ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_reason_chk" CHECK (
    "exception_reason_code" IS NOT NULL AND "exception_reason_code" IN ('PROVENANCE_CONFLICT', 'SOURCE_REFERENCE_UNAVAILABLE', 'CONTRACT_VERSION_UNSUPPORTED', 'HISTORICAL_RECORD_INCONSISTENT', 'OPERATOR_REVIEW_REQUIRED')
  );

ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_pairing_chk" CHECK (
    ("source_kind" = 'REVENUE_TIMELINE' AND "exception_reason_code" = 'PROVENANCE_CONFLICT')
    OR ("source_kind" = 'CLOSURE_PREREQUISITE_ASSESSMENT' AND "exception_reason_code" IN ('HISTORICAL_RECORD_INCONSISTENT', 'OPERATOR_REVIEW_REQUIRED'))
  );

-- The controlled basis: the one specific owner-backed condition that proves each reason (an owner's refusal alone is
-- never a basis), each NOT NULL explicitly.
ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_basis_chk" CHECK (
    "basis_code" IS NOT NULL AND "basis_record_id" IS NOT NULL AND (
      ("exception_reason_code" = 'PROVENANCE_CONFLICT' AND "basis_code" = 'UNLINKED_FROZEN_SUBMISSION')
      OR ("exception_reason_code" = 'HISTORICAL_RECORD_INCONSISTENT' AND "basis_code" IN ('ASSESSMENT_CASE_ORGANIZATION_MISMATCH', 'ASSESSMENT_CASE_DIGEST_MISMATCH'))
      OR ("exception_reason_code" = 'OPERATOR_REVIEW_REQUIRED' AND "basis_code" = 'ASSESSMENT_REVIEW_REQUIRED')
    )
  );

ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_fingerprint_chk" CHECK (
    ("source_kind" = 'REVENUE_TIMELINE' AND "source_fingerprint_sha256" IS NULL)
    OR ("source_kind" = 'CLOSURE_PREREQUISITE_ASSESSMENT' AND "source_fingerprint_sha256" IS NOT NULL AND "source_fingerprint_sha256" ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE "exception_intake_records"
  ADD CONSTRAINT "exception_intake_records_identity_chk" CHECK ("identity_key" IS NOT NULL AND "identity_key" ~ '^[0-9a-f]{64}$');

-- §4/§6 — an intake is recorded and created at the database's own transaction time; belongs to exactly the
-- organization that owns its Claim (Claim -> Encounter -> Patient); is recorded by a current member of that
-- organization; names a source that exists and belongs to exactly that Claim and organization under its stored
-- contract (a revenue timeline is named by its own Claim; an assessment through case -> frozen submission -> Claim),
-- copying the assessment's stored case digest, never computing one; its basis is a fact of the owners' stored rows at
-- this moment (checked after the identity):
--   UNLINKED_FROZEN_SUBMISSION — the basis record is a freeze of this Claim, the Claim has two or more freezes, no A6.9
--     link names the basis freeze, and no other freeze of the Claim that no link names was frozen at or after it;
--   ASSESSMENT_CASE_ORGANIZATION_MISMATCH — the basis record is the assessed case, whose organization is not the
--     assessment's;
--   ASSESSMENT_CASE_DIGEST_MISMATCH — the basis record is the assessed case, of the assessment's organization, whose
--     stored digest is not the assessment's copied one;
--   ASSESSMENT_REVIEW_REQUIRED — the basis record is the source assessment itself, stored as REVIEW_REQUIRED;
-- its identity key is exactly the SHA-256 of the canonical preimage of its own columns.
CREATE OR REPLACE FUNCTION exception_intake_records_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  owning_organization uuid;
  assessment RECORD;
  assessment_claim uuid;
  assessed_case RECORD;
  basis_frozen_at timestamptz;
  preimage text;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_intake_time: an intake is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT p."organization_id" INTO owning_organization
  FROM "claims" k
  JOIN "encounters" e ON e."id" = k."encounter_id"
  JOIN "patients" p ON p."id" = e."patient_id"
  WHERE k."id" = NEW."claim_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing Claim
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM owning_organization THEN
    RAISE EXCEPTION 'exception_intake_coherence: the organization must be the one that owns the Claim'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "organization_memberships" m WHERE m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id") THEN
    RAISE EXCEPTION 'exception_intake_member: an intake is recorded by a member of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."source_kind" = 'REVENUE_TIMELINE' THEN
    IF NEW."source_record_id" IS DISTINCT FROM NEW."claim_id" THEN
      RAISE EXCEPTION 'exception_intake_source: a revenue timeline is named by its own Claim'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."source_kind" = 'CLOSURE_PREREQUISITE_ASSESSMENT' THEN
    SELECT a.* INTO assessment FROM "evidence_prereq_results" a WHERE a."id" = NEW."source_record_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'exception_intake_source: the assessment does not exist'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT f."claim_id" INTO assessment_claim
    FROM "evidence_case_snapshots" h JOIN "claim_freezes" f ON f."id" = h."claim_submission_id"
    WHERE h."id" = assessment."evidence_case_id";
    IF assessment_claim IS DISTINCT FROM NEW."claim_id" OR assessment."organization_id" IS DISTINCT FROM NEW."organization_id" THEN
      RAISE EXCEPTION 'exception_intake_source: the assessment belongs to another Claim or organization'
        USING ERRCODE = 'check_violation';
    END IF;
    IF assessment."contract_version" IS DISTINCT FROM NEW."source_contract_version" OR assessment."case_manifest_sha256" IS DISTINCT FROM NEW."source_fingerprint_sha256" THEN
      RAISE EXCEPTION 'exception_intake_source: the source contract and digest must be the stored assessment''s'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  preimage := 'A8-EXCEPTION-INTAKE-1' || E'\n'
    || 'organization=' || NEW."organization_id"::text || E'\n'
    || 'claim=' || NEW."claim_id"::text || E'\n'
    || 'sourceKind=' || NEW."source_kind" || E'\n'
    || 'sourceRecord=' || NEW."source_record_id"::text || E'\n'
    || 'sourceContract=' || NEW."source_contract_version" || E'\n'
    || 'reason=' || NEW."exception_reason_code" || E'\n';
  IF NEW."identity_key" IS DISTINCT FROM encode(sha256(convert_to(preimage, 'UTF8')), 'hex') THEN
    RAISE EXCEPTION 'exception_intake_identity: the identity key must be the digest of the canonical preimage'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The basis fact, for exactly the three (source kind, basis) combinations the CHECKs admit. Any other combination
  -- (an uncontrolled basis, or a basis of another kind or reason) is refused by the basis, pairing or source-kind
  -- CHECK, which run after this trigger.
  IF NEW."source_kind" = 'REVENUE_TIMELINE' AND NEW."basis_code" = 'UNLINKED_FROZEN_SUBMISSION' THEN
    SELECT f."frozen_at" INTO basis_frozen_at FROM "claim_freezes" f WHERE f."id" = NEW."basis_record_id" AND f."claim_id" = NEW."claim_id";
    IF NOT FOUND
      OR (SELECT count(*) FROM "claim_freezes" f WHERE f."claim_id" = NEW."claim_id") < 2
      OR EXISTS (SELECT 1 FROM "claim_correction_links" l WHERE NEW."basis_record_id" IN (l."prior_submission_id", l."corrected_submission_id"))
      OR EXISTS (
        SELECT 1 FROM "claim_freezes" f
        WHERE f."claim_id" = NEW."claim_id" AND f."id" <> NEW."basis_record_id" AND f."frozen_at" >= basis_frozen_at
          AND NOT EXISTS (SELECT 1 FROM "claim_correction_links" l WHERE f."id" IN (l."prior_submission_id", l."corrected_submission_id"))
      ) THEN
      RAISE EXCEPTION 'exception_intake_basis: an unlinked frozen submission must be the latest freeze of the Claim that no correction link names'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."source_kind" = 'CLOSURE_PREREQUISITE_ASSESSMENT' AND NEW."basis_code" IN ('ASSESSMENT_CASE_ORGANIZATION_MISMATCH', 'ASSESSMENT_CASE_DIGEST_MISMATCH') THEN
    SELECT h."id", h."organization_id", h."manifest_sha256" INTO assessed_case FROM "evidence_case_snapshots" h WHERE h."id" = assessment."evidence_case_id";
    IF NOT FOUND OR NEW."basis_record_id" IS DISTINCT FROM assessed_case."id"
      OR (NEW."basis_code" = 'ASSESSMENT_CASE_ORGANIZATION_MISMATCH' AND assessed_case."organization_id" IS NOT DISTINCT FROM assessment."organization_id")
      OR (NEW."basis_code" = 'ASSESSMENT_CASE_DIGEST_MISMATCH' AND (assessed_case."organization_id" IS DISTINCT FROM assessment."organization_id" OR assessed_case."manifest_sha256" IS NOT DISTINCT FROM assessment."case_manifest_sha256")) THEN
      RAISE EXCEPTION 'exception_intake_basis: the assessment must disagree with its own stored case exactly as the basis states'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."source_kind" = 'CLOSURE_PREREQUISITE_ASSESSMENT' AND NEW."basis_code" = 'ASSESSMENT_REVIEW_REQUIRED' THEN
    IF NEW."basis_record_id" IS DISTINCT FROM NEW."source_record_id" OR assessment."assessment_code" IS DISTINCT FROM 'REVIEW_REQUIRED' THEN
      RAISE EXCEPTION 'exception_intake_basis: operator review requires the source assessment itself, stored as REVIEW_REQUIRED'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_intake_records_insert_guard_trg
  BEFORE INSERT ON "exception_intake_records"
  FOR EACH ROW EXECUTE FUNCTION exception_intake_records_insert_guard();

-- §6 — intakes are history: never updated (not even a no-op update), never deleted and never wiped in bulk (a
-- TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_intake_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_intake_records_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_intake_records"
  FOR EACH ROW EXECUTE FUNCTION exception_intake_append_only();

CREATE TRIGGER exception_intake_records_no_truncate_trg
  BEFORE TRUNCATE ON "exception_intake_records"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_intake_append_only();

-- There is deliberately no status, severity, priority, SLA, assignment, resolution, narrative, amount, currency,
-- payer, balance or current/latest column, no export table, and no new column on any A6 or A7 table.
