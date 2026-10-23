-- A7.3 — Adjudication Evidence Readiness & Provenance Gate
--
-- Creates exactly one append-only table: evidence_gate_results (A7-ADJ-READINESS-1), the immutable internal
-- readiness result of exactly one A7.2 source_evidence_classifications row, with its indexes, CHECKs, derivation
-- guard, append-only and TRUNCATE triggers. No applied migration is modified, no existing table is altered, and
-- the generated statements below were produced schema-to-schema with no unrelated drift.
--
-- A readiness result says whether trusted payer-adjudication evidence exists for a classified source. It is never
-- an insurer adjudication, payer response, denial, allowance, cash receipt, settlement or claim status, and it is
-- derived from the classification's STORED outcome: the A7.2 classifier and fingerprint are never re-run here.
-- (Physical name kept clear of the "adjudication" and "readiness" table scans; the API keeps the business name.)

-- CreateTable
CREATE TABLE "evidence_gate_results" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "source_evidence_id" UUID NOT NULL,
    "classification_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "readiness_code" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "classification_fingerprint_sha256" CHAR(64) NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_gate_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_gate_results_organization_id_idx" ON "evidence_gate_results"("organization_id");

-- CreateIndex
CREATE INDEX "evidence_gate_results_source_evidence_id_idx" ON "evidence_gate_results"("source_evidence_id");

-- CreateIndex
CREATE INDEX "evidence_gate_results_recorded_by_user_id_idx" ON "evidence_gate_results"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "evidence_gate_results_identity_key" ON "evidence_gate_results"("classification_id", "contract_version");

-- AddForeignKey
ALTER TABLE "evidence_gate_results" ADD CONSTRAINT "evidence_gate_results_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_gate_results" ADD CONSTRAINT "evidence_gate_results_source_evidence_id_fkey" FOREIGN KEY ("source_evidence_id") REFERENCES "revenue_source_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_gate_results" ADD CONSTRAINT "evidence_gate_results_classification_id_fkey" FOREIGN KEY ("classification_id") REFERENCES "source_evidence_classifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_gate_results" ADD CONSTRAINT "evidence_gate_results_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written integrity (A7.3 §4, §5) -------------------------------------------------------------

-- §4 — the fixed contract and the controlled vocabularies, each NOT NULL explicitly (a NULL must never pass an IN
-- list). Only the three storable results exist: CONFLICT is never stored (§3/§5 — no fictitious result), and no
-- ready, adjudicated, paid, allowed, denied, settled, remitted or balance code exists at all.
ALTER TABLE "evidence_gate_results"
  ADD CONSTRAINT "evidence_gate_results_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A7-ADJ-READINESS-1');

ALTER TABLE "evidence_gate_results"
  ADD CONSTRAINT "evidence_gate_results_readiness_chk" CHECK (
    "readiness_code" IS NOT NULL AND "readiness_code" IN ('NOT_READY_FOR_ADJUDICATION', 'SOURCE_REQUIRES_REVIEW', 'SOURCE_UNSUPPORTED')
  );

ALTER TABLE "evidence_gate_results"
  ADD CONSTRAINT "evidence_gate_results_reason_chk" CHECK (
    "reason_code" IS NOT NULL AND "reason_code" IN ('EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT', 'CLASSIFICATION_REVIEW_REQUIRED', 'CLASSIFICATION_UNSUPPORTED')
  );

-- Each readiness has exactly one reason.
ALTER TABLE "evidence_gate_results"
  ADD CONSTRAINT "evidence_gate_results_pairing_chk" CHECK (
    ("readiness_code" = 'NOT_READY_FOR_ADJUDICATION' AND "reason_code" = 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT')
    OR ("readiness_code" = 'SOURCE_REQUIRES_REVIEW' AND "reason_code" = 'CLASSIFICATION_REVIEW_REQUIRED')
    OR ("readiness_code" = 'SOURCE_UNSUPPORTED' AND "reason_code" = 'CLASSIFICATION_UNSUPPORTED')
  );

ALTER TABLE "evidence_gate_results"
  ADD CONSTRAINT "evidence_gate_results_fingerprint_chk" CHECK ("classification_fingerprint_sha256" IS NOT NULL AND "classification_fingerprint_sha256" ~ '^[0-9a-f]{64}$');

-- §4/§5 — the database is the backstop behind every service check, so a direct INSERT cannot bypass it. A result:
-- * is recorded and created at the database's own transaction time;
-- * names exactly the source its classification belongs to (no classification of another source);
-- * belongs to exactly the organization of its classification, of that classification's A7.1 source and of the
--   source's frozen submission;
-- * reads only a controlled A7-EVIDENCE-CLASS-1 classification with a well-formed fingerprint, whose
--   classification, outcome and reason form one of the combinations the A7.2 classifier can produce — anything
--   else is a provenance conflict and no result is stored;
-- * carries exactly the readiness and reason derived from that stored classification (same table as the A7.3
--   reducer), and exactly the classification's stored fingerprint (copied, never recomputed).
CREATE OR REPLACE FUNCTION evidence_gate_results_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  cls RECORD;
  src RECORD;
  submission_organization uuid;
  expected_readiness text;
  expected_reason text;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'evidence_gate_result_time: a readiness result is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.* INTO cls FROM "source_evidence_classifications" c WHERE c."id" = NEW."classification_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing classification
  END IF;
  IF NEW."source_evidence_id" IS DISTINCT FROM cls."source_evidence_id" THEN
    RAISE EXCEPTION 'evidence_gate_result_linkage: the source must be exactly the one its classification belongs to'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.* INTO src FROM "revenue_source_evidence" r WHERE r."id" = cls."source_evidence_id";
  SELECT p."organization_id" INTO submission_organization
  FROM "claim_freezes" f
  JOIN "claims" k ON k."id" = f."claim_id"
  JOIN "encounters" e ON e."id" = k."encounter_id"
  JOIN "patients" p ON p."id" = e."patient_id"
  WHERE f."id" = src."claim_submission_id";
  IF NEW."organization_id" IS DISTINCT FROM cls."organization_id" OR NEW."organization_id" IS DISTINCT FROM src."organization_id"
     OR NEW."organization_id" IS DISTINCT FROM submission_organization THEN
    RAISE EXCEPTION 'evidence_gate_result_coherence: the organization must own the classification, its source and the frozen submission'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The reducer's table, exact combinations only (identical to evidence-gate.reducer.ts).
  IF cls."contract_version" IS DISTINCT FROM 'A7-EVIDENCE-CLASS-1' OR cls."source_fingerprint_sha256" IS NULL
     OR cls."source_fingerprint_sha256" !~ '^[0-9a-f]{64}$' THEN
    expected_readiness := NULL;
  ELSIF (cls."classification_code", cls."normalization_outcome", cls."reason_code") = ('INTERNAL_DECLARATION', 'CLASSIFIED', 'SYNTHETIC_INTERNAL_SOURCE') THEN
    expected_readiness := 'NOT_READY_FOR_ADJUDICATION'; expected_reason := 'EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT';
  ELSIF (cls."classification_code", cls."normalization_outcome", cls."reason_code") IN (
          ('EXTERNAL_SOURCE_UNVERIFIED', 'NEEDS_REVIEW', 'EXTERNAL_PROOF_ABSENT'),
          ('INSUFFICIENT_CONTEXT', 'NEEDS_REVIEW', 'SOURCE_CONTEXT_MISSING'),
          ('INSUFFICIENT_CONTEXT', 'NEEDS_REVIEW', 'SOURCE_CONTEXT_CONTRADICTORY')) THEN
    expected_readiness := 'SOURCE_REQUIRES_REVIEW'; expected_reason := 'CLASSIFICATION_REVIEW_REQUIRED';
  ELSIF (cls."classification_code", cls."normalization_outcome", cls."reason_code") IN (
          ('UNSUPPORTED_SOURCE', 'UNSUPPORTED', 'SOURCE_KIND_UNSUPPORTED'),
          ('UNSUPPORTED_SOURCE', 'UNSUPPORTED', 'SOURCE_CONTRACT_UNSUPPORTED')) THEN
    expected_readiness := 'SOURCE_UNSUPPORTED'; expected_reason := 'CLASSIFICATION_UNSUPPORTED';
  ELSE
    expected_readiness := NULL;
  END IF;
  IF expected_readiness IS NULL THEN
    RAISE EXCEPTION 'evidence_gate_result_conflict: the classification is not a controlled A7-EVIDENCE-CLASS-1 result; no readiness is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."readiness_code" IS DISTINCT FROM expected_readiness OR NEW."reason_code" IS DISTINCT FROM expected_reason THEN
    RAISE EXCEPTION 'evidence_gate_result_derivation: the readiness must be the one derived from its classification'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."classification_fingerprint_sha256" IS DISTINCT FROM cls."source_fingerprint_sha256" THEN
    RAISE EXCEPTION 'evidence_gate_result_fingerprint: the fingerprint must be exactly the classification''s stored fingerprint'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_gate_results_insert_guard_trg
  BEFORE INSERT ON "evidence_gate_results"
  FOR EACH ROW EXECUTE FUNCTION evidence_gate_results_insert_guard();

-- §4 — a readiness result is history: never updated (not even a no-op update), never deleted and never wiped in bulk.
CREATE OR REPLACE FUNCTION evidence_gate_results_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_gate_results_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_gate_results"
  FOR EACH ROW EXECUTE FUNCTION evidence_gate_results_append_only();

-- TRUNCATE removes rows without firing row-level DELETE triggers, so it gets its own statement-level refusal
-- (this also stops a TRUNCATE ... CASCADE from a referenced table from wiping the results).
CREATE TRIGGER evidence_gate_results_no_truncate_trg
  BEFORE TRUNCATE ON "evidence_gate_results"
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_gate_results_append_only();

-- There is deliberately no status, ready/adjudicated/paid/allowed/denied/settled label, amount, currency, payer,
-- remittance, external reference, date of service, current or latest pointer, and no new column on any A6, A7.1 or
-- A7.2 table.
