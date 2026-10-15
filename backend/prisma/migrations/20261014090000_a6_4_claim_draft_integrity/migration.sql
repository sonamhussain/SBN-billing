-- A6.4 — Claim Draft Assembly & Claim-Level Integrity
--
-- Creates exactly two tables: claim_draft_assessments and claim_draft_findings (A6-DRAFT-1), with their
-- indexes, CHECKs and integrity/history triggers. No applied migration is modified, no existing table is
-- altered, and the generated statements below were produced schema-to-schema with no unrelated drift. No
-- approval, reviewer, lifecycle, payload, submission, transport, patient-share or clinical HIE column.

-- CreateTable
CREATE TABLE "claim_draft_assessments" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "pricing_run_id" UUID NOT NULL,
    "draft_contract_version" TEXT NOT NULL,
    "handoff_assessment_id" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "assembly_fingerprint" TEXT NOT NULL,
    "pricing_input_fingerprint" TEXT NOT NULL,
    "active_line_count" INTEGER NOT NULL,
    "active_diagnosis_count" INTEGER NOT NULL,
    "finding_count" INTEGER NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_draft_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_draft_findings" (
    "id" UUID NOT NULL,
    "draft_assessment_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "finding_code" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "owner_scope" TEXT NOT NULL,
    "related_claim_line_id" UUID,
    "related_claim_diagnosis_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_draft_findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claim_draft_assessments_claim_id_evaluated_at_idx" ON "claim_draft_assessments"("claim_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "claim_draft_assessments_pricing_run_id_idx" ON "claim_draft_assessments"("pricing_run_id");

-- CreateIndex
CREATE INDEX "claim_draft_assessments_handoff_assessment_id_idx" ON "claim_draft_assessments"("handoff_assessment_id");

-- CreateIndex
CREATE INDEX "claim_draft_findings_related_claim_line_id_idx" ON "claim_draft_findings"("related_claim_line_id");

-- CreateIndex
CREATE INDEX "claim_draft_findings_related_claim_diagnosis_id_idx" ON "claim_draft_findings"("related_claim_diagnosis_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_draft_findings_draft_assessment_id_ordinal_key" ON "claim_draft_findings"("draft_assessment_id", "ordinal");

-- AddForeignKey
ALTER TABLE "claim_draft_assessments" ADD CONSTRAINT "claim_draft_assessments_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_draft_assessments" ADD CONSTRAINT "claim_draft_assessments_pricing_run_id_fkey" FOREIGN KEY ("pricing_run_id") REFERENCES "claim_pricing_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_draft_assessments" ADD CONSTRAINT "claim_draft_assessments_handoff_assessment_id_fkey" FOREIGN KEY ("handoff_assessment_id") REFERENCES "pre_claim_readiness_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_draft_assessments" ADD CONSTRAINT "claim_draft_assessments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_draft_findings" ADD CONSTRAINT "claim_draft_findings_draft_assessment_id_fkey" FOREIGN KEY ("draft_assessment_id") REFERENCES "claim_draft_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_draft_findings" ADD CONSTRAINT "claim_draft_findings_related_claim_line_id_fkey" FOREIGN KEY ("related_claim_line_id") REFERENCES "claim_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_draft_findings" ADD CONSTRAINT "claim_draft_findings_related_claim_diagnosis_id_fkey" FOREIGN KEY ("related_claim_diagnosis_id") REFERENCES "claim_diagnoses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity (A6.4 §6, §10) ------------------------------------------------------------

-- §3/§6 — an assessment carries its fixed contract, one of the four outcomes, SHA-256 fingerprints and
-- non-negative counts. The outcome is never a Claim lifecycle, approval or submission value.
ALTER TABLE "claim_draft_assessments"
  ADD CONSTRAINT "claim_draft_assessments_contract_version_chk" CHECK ("draft_contract_version" = 'A6-DRAFT-1');

ALTER TABLE "claim_draft_assessments"
  ADD CONSTRAINT "claim_draft_assessments_outcome_chk" CHECK ("outcome" IN ('REVIEWABLE', 'INCOMPLETE', 'STALE', 'INVALID'));

ALTER TABLE "claim_draft_assessments"
  ADD CONSTRAINT "claim_draft_assessments_fingerprint_chk" CHECK (
    "assembly_fingerprint" ~ '^[0-9a-f]{64}$' AND "pricing_input_fingerprint" ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE "claim_draft_assessments"
  ADD CONSTRAINT "claim_draft_assessments_counts_chk" CHECK (
    "active_line_count" >= 0 AND "active_diagnosis_count" >= 0 AND "finding_count" >= 0
  );

-- §6/§10 — an assessment judges exactly one pricing run OF ITS OWN Claim, under the readiness assessment
-- that Claim is bound to, and records that run's own input fingerprint. A cross-Claim (and therefore
-- cross-tenant) pricing binding or a different handoff basis is refused by the database itself.
CREATE OR REPLACE FUNCTION claim_draft_assessments_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  run_claim uuid;
  run_fingerprint text;
  bound_assessment uuid;
BEGIN
  SELECT "claim_id", "input_structure_fingerprint" INTO run_claim, run_fingerprint
  FROM "claim_pricing_runs" WHERE "id" = NEW."pricing_run_id";
  SELECT "pre_claim_readiness_assessment_id" INTO bound_assessment FROM "claims" WHERE "id" = NEW."claim_id";
  IF run_claim IS NULL OR bound_assessment IS NULL THEN
    RETURN NEW; -- the foreign keys report a missing Claim or pricing run
  END IF;
  IF run_claim IS DISTINCT FROM NEW."claim_id" THEN
    RAISE EXCEPTION 'claim_draft_assessment_coherence: the pricing run belongs to another claim'
      USING ERRCODE = 'check_violation';
  END IF;
  IF bound_assessment IS DISTINCT FROM NEW."handoff_assessment_id" THEN
    RAISE EXCEPTION 'claim_draft_assessment_coherence: the handoff assessment is not the one the claim is bound to'
      USING ERRCODE = 'check_violation';
  END IF;
  IF run_fingerprint IS DISTINCT FROM NEW."pricing_input_fingerprint" THEN
    RAISE EXCEPTION 'claim_draft_assessment_coherence: the pricing input fingerprint is not the run''s own'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_draft_assessments_insert_guard_trg
  BEFORE INSERT ON "claim_draft_assessments"
  FOR EACH ROW EXECUTE FUNCTION claim_draft_assessments_insert_guard();

-- §6/§10 — an assessment and its findings are review evidence: never updated, never deleted. A
-- re-evaluation is a new assessment; history is never rewritten.
CREATE OR REPLACE FUNCTION claim_draft_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_draft_assessments_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_draft_assessments"
  FOR EACH ROW EXECUTE FUNCTION claim_draft_append_only();

CREATE TRIGGER claim_draft_findings_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_draft_findings"
  FOR EACH ROW EXECUTE FUNCTION claim_draft_append_only();

-- §6/§8 — a finding is a bounded catalogue code with a fixed severity and owner vocabulary at a 1-based
-- ordinal. No free text column exists.
ALTER TABLE "claim_draft_findings"
  ADD CONSTRAINT "claim_draft_findings_ordinal_chk" CHECK ("ordinal" >= 1);

ALTER TABLE "claim_draft_findings"
  ADD CONSTRAINT "claim_draft_findings_code_chk" CHECK ("finding_code" ~ '^CLAIM_DRAFT_[A-Z_]{1,64}$');

ALTER TABLE "claim_draft_findings"
  ADD CONSTRAINT "claim_draft_findings_severity_chk" CHECK ("severity" IN ('BLOCKER', 'ADVISORY'));

ALTER TABLE "claim_draft_findings"
  ADD CONSTRAINT "claim_draft_findings_owner_scope_chk" CHECK (
    "owner_scope" IN ('CLAIM', 'HANDOFF', 'LINE', 'DIAGNOSIS', 'POINTER', 'PRICING', 'COMMERCIAL', 'SOURCE', 'JURISDICTION')
  );

-- §6/§10 — a finding is written by the transaction that wrote its assessment (the assessment row's xmin
-- is that transaction and the assessment can never be updated), and the line or diagnosis it names
-- belongs to the assessment's own Claim.
CREATE OR REPLACE FUNCTION claim_draft_findings_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  assessment_xmin xid;
  assessment_claim uuid;
BEGIN
  SELECT xmin, "claim_id" INTO assessment_xmin, assessment_claim
  FROM "claim_draft_assessments" WHERE "id" = NEW."draft_assessment_id";
  IF assessment_xmin IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing assessment
  END IF;
  IF assessment_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'claim_draft_findings: a finding can only be recorded with its own assessment'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."related_claim_line_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "claim_lines" WHERE "id" = NEW."related_claim_line_id" AND "claim_id" = assessment_claim) THEN
    RAISE EXCEPTION 'claim_draft_finding_scope: the related claim line belongs to another claim'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."related_claim_diagnosis_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "claim_diagnoses" WHERE "id" = NEW."related_claim_diagnosis_id" AND "claim_id" = assessment_claim) THEN
    RAISE EXCEPTION 'claim_draft_finding_scope: the related claim diagnosis belongs to another claim'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_draft_findings_insert_guard_trg
  BEFORE INSERT ON "claim_draft_findings"
  FOR EACH ROW EXECUTE FUNCTION claim_draft_findings_insert_guard();

-- §6/§10 — at commit an assessment holds exactly finding_count findings at ordinals 1..N, and its outcome
-- agrees with them: REVIEWABLE exactly when no finding is a BLOCKER. It is never half-written.
CREATE OR REPLACE FUNCTION claim_draft_assessments_complete()
RETURNS TRIGGER AS $$
DECLARE
  total_findings integer;
  highest_ordinal integer;
  blocker_findings integer;
BEGIN
  SELECT count(*), coalesce(max("ordinal"), 0), count(*) FILTER (WHERE "severity" = 'BLOCKER')
    INTO total_findings, highest_ordinal, blocker_findings
  FROM "claim_draft_findings" WHERE "draft_assessment_id" = NEW."id";
  IF total_findings <> NEW."finding_count" OR highest_ordinal <> NEW."finding_count" THEN
    RAISE EXCEPTION 'claim_draft_assessments_complete: the assessment does not hold exactly its declared findings'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."outcome" = 'REVIEWABLE') <> (blocker_findings = 0) THEN
    RAISE EXCEPTION 'claim_draft_assessments_complete: REVIEWABLE exactly when no finding is a blocker'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER claim_draft_assessments_complete_trg
  AFTER INSERT ON "claim_draft_assessments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION claim_draft_assessments_complete();

-- There is deliberately no approval, reviewer, sign-off, lifecycle state, payload, payload hash,
-- ClaimSubmission, DHPO/eClaimLink/XML, X12/NPI, patient share, Net or NABIDH/Malaffi/Riayati column, and
-- no current-draft-assessment pointer on the Claim.
