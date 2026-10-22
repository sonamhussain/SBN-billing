-- A7.2 — Revenue Evidence Classification & Normalization
--
-- Creates exactly one append-only table: source_evidence_classifications (A7-EVIDENCE-CLASS-1), the immutable
-- classification of exactly one A7.1 revenue_source_evidence record, with its indexes, CHECKs, derivation guard,
-- append-only and TRUNCATE triggers. No applied migration is modified, no existing table is altered, and the
-- generated statements below were produced schema-to-schema with no unrelated drift.
--
-- A classification says what kind of internal evidence was registered and whether it normalizes without
-- ambiguity. It never declares payer adjudication, allowance, denial, payment, contractual adjustment or a
-- receivable, and never promotes a source to external truth. There is no status, current or latest pointer.

-- CreateTable
CREATE TABLE "source_evidence_classifications" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_evidence_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "classification_code" TEXT NOT NULL,
    "normalization_outcome" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "source_fingerprint_sha256" CHAR(64) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_evidence_classifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_evidence_classifications_organization_id_idx" ON "source_evidence_classifications"("organization_id");

-- CreateIndex
CREATE INDEX "source_evidence_classifications_recorded_by_user_id_idx" ON "source_evidence_classifications"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_evidence_classifications_identity_key" ON "source_evidence_classifications"("source_evidence_id", "contract_version");

-- AddForeignKey
ALTER TABLE "source_evidence_classifications" ADD CONSTRAINT "source_evidence_classifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_evidence_classifications" ADD CONSTRAINT "source_evidence_classifications_source_evidence_id_fkey" FOREIGN KEY ("source_evidence_id") REFERENCES "revenue_source_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_evidence_classifications" ADD CONSTRAINT "source_evidence_classifications_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A7.2 §3, §5) -------------------------------------------------------------

-- §3 — the fixed contract and the controlled vocabularies, each NOT NULL explicitly (a NULL must never pass an
-- IN list). EXTERNAL_SOURCE_VERIFIED belongs to the contract vocabulary but is disabled in A7.2: no accepted
-- A7.1 source carries an authenticated proof, so no row can ever claim it.
ALTER TABLE "source_evidence_classifications"
  ADD CONSTRAINT "source_evidence_classifications_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A7-EVIDENCE-CLASS-1');

ALTER TABLE "source_evidence_classifications"
  ADD CONSTRAINT "source_evidence_classifications_code_chk" CHECK (
    "classification_code" IS NOT NULL AND "classification_code" IN ('INTERNAL_DECLARATION', 'EXTERNAL_SOURCE_UNVERIFIED', 'EXTERNAL_SOURCE_VERIFIED', 'INSUFFICIENT_CONTEXT', 'UNSUPPORTED_SOURCE')
  );

ALTER TABLE "source_evidence_classifications"
  ADD CONSTRAINT "source_evidence_classifications_verified_disabled_chk" CHECK ("classification_code" <> 'EXTERNAL_SOURCE_VERIFIED');

ALTER TABLE "source_evidence_classifications"
  ADD CONSTRAINT "source_evidence_classifications_outcome_chk" CHECK (
    "normalization_outcome" IS NOT NULL AND "normalization_outcome" IN ('CLASSIFIED', 'NEEDS_REVIEW', 'UNSUPPORTED')
  );

ALTER TABLE "source_evidence_classifications"
  ADD CONSTRAINT "source_evidence_classifications_reason_chk" CHECK (
    "reason_code" IS NOT NULL AND "reason_code" IN ('SYNTHETIC_INTERNAL_SOURCE', 'EXTERNAL_PROOF_ABSENT', 'SOURCE_CONTEXT_MISSING', 'SOURCE_CONTEXT_CONTRADICTORY', 'SOURCE_KIND_UNSUPPORTED', 'SOURCE_CONTRACT_UNSUPPORTED')
  );

ALTER TABLE "source_evidence_classifications"
  ADD CONSTRAINT "source_evidence_classifications_fingerprint_chk" CHECK ("source_fingerprint_sha256" IS NOT NULL AND "source_fingerprint_sha256" ~ '^[0-9a-f]{64}$');

-- §5 — the database is the backstop behind every service check, so a direct INSERT cannot bypass it. A
-- classification:
-- * is recorded and created at the database's own transaction time;
-- * belongs to exactly the organization of its A7.1 source record and of that record's frozen submission;
-- * carries exactly the classification the A7.2 classifier derives from that source's own facts (same rules,
--   same precedence) — a forged, client-chosen or "verified" classification is refused;
-- * carries exactly the source fingerprint recomputed here from the source's own facts: SHA-256 of
--   "SBN-A7-EVIDENCE-CLASS-1\n" and the "name=value\n" lines contract, sourceEvidenceId, sourceKind,
--   sourceReference, sourceVersion, claimSubmissionId and receivedAtMicros (integer microseconds since epoch).
CREATE OR REPLACE FUNCTION source_evidence_classifications_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  src RECORD;
  submission_organization uuid;
  expected_code text;
  expected_outcome text;
  expected_reason text;
  expected_fingerprint text;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'source_evidence_classification_time: a classification is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.* INTO src FROM "revenue_source_evidence" r WHERE r."id" = NEW."source_evidence_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing source record
  END IF;
  SELECT p."organization_id" INTO submission_organization
  FROM "claim_freezes" f
  JOIN "claims" c ON c."id" = f."claim_id"
  JOIN "encounters" e ON e."id" = c."encounter_id"
  JOIN "patients" p ON p."id" = e."patient_id"
  WHERE f."id" = src."claim_submission_id";
  IF NEW."organization_id" IS DISTINCT FROM src."organization_id" OR NEW."organization_id" IS DISTINCT FROM submission_organization THEN
    RAISE EXCEPTION 'source_evidence_classification_coherence: the organization must own the source record and its frozen submission'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The classifier's precedence, first match wins (identical to evidence-classification.classifier.ts).
  IF src."source_kind" = 'EXTERNAL_VERIFIED' THEN
    RAISE EXCEPTION 'source_evidence_classification_derivation: external verification without an authenticated proof is never classified'
      USING ERRCODE = 'check_violation';
  ELSIF src."source_kind" IS NULL OR src."source_kind" = '' OR src."source_reference" IS NULL OR src."source_reference" = ''
     OR src."source_version" IS NULL OR src."source_version" = '' OR submission_organization IS NULL THEN
    expected_code := 'INSUFFICIENT_CONTEXT'; expected_outcome := 'NEEDS_REVIEW'; expected_reason := 'SOURCE_CONTEXT_MISSING';
  ELSIF src."organization_id" IS DISTINCT FROM submission_organization OR src."source_digest_sha256" IS NOT NULL THEN
    expected_code := 'INSUFFICIENT_CONTEXT'; expected_outcome := 'NEEDS_REVIEW'; expected_reason := 'SOURCE_CONTEXT_CONTRADICTORY';
  ELSIF src."source_version" <> 'A7-REVENUE-SOURCE-1' THEN
    expected_code := 'UNSUPPORTED_SOURCE'; expected_outcome := 'UNSUPPORTED'; expected_reason := 'SOURCE_CONTRACT_UNSUPPORTED';
  ELSIF src."source_kind" = 'EXTERNAL_DECLARED' THEN
    expected_code := 'EXTERNAL_SOURCE_UNVERIFIED'; expected_outcome := 'NEEDS_REVIEW'; expected_reason := 'EXTERNAL_PROOF_ABSENT';
  ELSIF src."source_kind" = 'INTERNAL_SYNTHETIC' THEN
    expected_code := 'INTERNAL_DECLARATION'; expected_outcome := 'CLASSIFIED'; expected_reason := 'SYNTHETIC_INTERNAL_SOURCE';
  ELSE
    expected_code := 'UNSUPPORTED_SOURCE'; expected_outcome := 'UNSUPPORTED'; expected_reason := 'SOURCE_KIND_UNSUPPORTED';
  END IF;
  IF NEW."classification_code" IS DISTINCT FROM expected_code OR NEW."normalization_outcome" IS DISTINCT FROM expected_outcome OR NEW."reason_code" IS DISTINCT FROM expected_reason THEN
    RAISE EXCEPTION 'source_evidence_classification_derivation: the classification must be the one derived from its source''s own facts'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_fingerprint := encode(sha256(convert_to(
    'SBN-A7-EVIDENCE-CLASS-1' || chr(10) ||
    'contract=' || NEW."contract_version" || chr(10) ||
    'sourceEvidenceId=' || src."id"::text || chr(10) ||
    'sourceKind=' || src."source_kind" || chr(10) ||
    'sourceReference=' || src."source_reference" || chr(10) ||
    'sourceVersion=' || src."source_version" || chr(10) ||
    'claimSubmissionId=' || src."claim_submission_id"::text || chr(10) ||
    'receivedAtMicros=' || (extract(epoch FROM src."received_at") * 1000000)::bigint::text || chr(10),
    'UTF8')), 'hex');
  IF NEW."source_fingerprint_sha256" IS DISTINCT FROM expected_fingerprint THEN
    RAISE EXCEPTION 'source_evidence_classification_fingerprint: the fingerprint must be recomputed from its source''s own facts'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_evidence_classifications_insert_guard_trg
  BEFORE INSERT ON "source_evidence_classifications"
  FOR EACH ROW EXECUTE FUNCTION source_evidence_classifications_insert_guard();

-- §5 — a classification is history: never updated (not even a no-op update), never deleted and never wiped in
-- bulk.
CREATE OR REPLACE FUNCTION source_evidence_classifications_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER source_evidence_classifications_append_only_trg
  BEFORE UPDATE OR DELETE ON "source_evidence_classifications"
  FOR EACH ROW EXECUTE FUNCTION source_evidence_classifications_append_only();

-- TRUNCATE removes rows without firing row-level DELETE triggers, so it gets its own statement-level refusal
-- (this also stops a TRUNCATE ... CASCADE from a referenced table from wiping the classifications).
CREATE TRIGGER source_evidence_classifications_no_truncate_trg
  BEFORE TRUNCATE ON "source_evidence_classifications"
  FOR EACH STATEMENT EXECUTE FUNCTION source_evidence_classifications_append_only();

-- There is deliberately no status, paid/denied/accepted label, amount, currency, payer, remittance, external
-- time, current or latest pointer, and no new column on revenue_source_evidence or claim_freezes.
