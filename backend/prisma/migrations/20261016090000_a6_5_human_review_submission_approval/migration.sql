-- A6.5 — Human Review & Submission Approval
--
-- Creates exactly one table: claim_review_events (A6-REVIEW-1), with its indexes, CHECKs and its
-- integrity/history triggers. No applied migration is modified, no existing table is altered, and the
-- generated statements below were produced schema-to-schema with no unrelated drift. A decision is a human
-- authorization record only: no Claim approval state, no latest-approval pointer, no payload, payload hash,
-- ClaimSubmission, lifecycle or transport column.

-- CreateTable
CREATE TABLE "claim_review_events" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "draft_assessment_id" UUID NOT NULL,
    "reviewer_user_id" UUID NOT NULL,
    "decision_code" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "approval_fingerprint" TEXT,
    "reason_code" TEXT,
    "referenced_approval_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "review_contract_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claim_review_events_referenced_approval_id_key" ON "claim_review_events"("referenced_approval_id");

-- CreateIndex
CREATE INDEX "claim_review_events_draft_assessment_id_idx" ON "claim_review_events"("draft_assessment_id");

-- CreateIndex
CREATE INDEX "claim_review_events_reviewer_user_id_idx" ON "claim_review_events"("reviewer_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_review_events_claim_id_sequence_key" ON "claim_review_events"("claim_id", "sequence");

-- AddForeignKey
ALTER TABLE "claim_review_events" ADD CONSTRAINT "claim_review_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_review_events" ADD CONSTRAINT "claim_review_events_draft_assessment_id_fkey" FOREIGN KEY ("draft_assessment_id") REFERENCES "claim_draft_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_review_events" ADD CONSTRAINT "claim_review_events_reviewer_user_id_fkey" FOREIGN KEY ("reviewer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_review_events" ADD CONSTRAINT "claim_review_events_referenced_approval_id_fkey" FOREIGN KEY ("referenced_approval_id") REFERENCES "claim_review_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A6.5 §3, §5) -------------------------------------------------------------

-- §2/§3 — a decision carries its fixed contract, one of the four decision codes, a positive Claim-local
-- sequence and, when it has a reason, one of the five controlled reason codes (never free text).
ALTER TABLE "claim_review_events"
  ADD CONSTRAINT "claim_review_events_contract_version_chk" CHECK ("review_contract_version" = 'A6-REVIEW-1');

ALTER TABLE "claim_review_events"
  ADD CONSTRAINT "claim_review_events_decision_chk" CHECK ("decision_code" IN ('APPROVE', 'RETURN', 'REJECT', 'REVOKE'));

ALTER TABLE "claim_review_events"
  ADD CONSTRAINT "claim_review_events_sequence_chk" CHECK ("sequence" >= 1);

ALTER TABLE "claim_review_events"
  ADD CONSTRAINT "claim_review_events_reason_chk" CHECK (
    "reason_code" IS NULL OR "reason_code" IN ('REVIEW_DOCUMENTATION_REQUIRED', 'REVIEW_CODING_CORRECTION', 'REVIEW_PRICING_QUESTION', 'REVIEW_INTEGRITY_CONCERN', 'REVIEW_OTHER')
  );

-- §3 — the shape of each decision: APPROVE carries a 64-character lowercase SHA-256 fingerprint and no
-- reason or target; RETURN and REJECT carry a reason and no fingerprint or target; REVOKE names the
-- approval it withdraws (a reason is optional) and carries no fingerprint.
ALTER TABLE "claim_review_events"
  ADD CONSTRAINT "claim_review_events_shape_chk" CHECK (
    ("decision_code" = 'APPROVE' AND "approval_fingerprint" IS NOT NULL AND "approval_fingerprint" ~ '^[0-9a-f]{64}$' AND "reason_code" IS NULL AND "referenced_approval_id" IS NULL)
    OR ("decision_code" IN ('RETURN', 'REJECT') AND "approval_fingerprint" IS NULL AND "reason_code" IS NOT NULL AND "referenced_approval_id" IS NULL)
    OR ("decision_code" = 'REVOKE' AND "approval_fingerprint" IS NULL AND "referenced_approval_id" IS NOT NULL)
  );

-- §3/§5 — the database is the backstop behind every service check:
-- * both instants are the database's own transaction time, so nothing is backdated or postdated;
-- * the decision is about a draft assessment OF ITS OWN Claim (a cross-Claim, and therefore cross-tenant,
--   linkage is refused);
-- * the sequence is exactly the next one of that Claim (no gap, no reuse; the unique key is the backstop
--   for two concurrent writers);
-- * an APPROVE names a REVIEWABLE assessment with that assessment's own fingerprint, is made by someone
--   other than the creator of the Claim and of the assessment, and never repeats the identical fingerprint
--   of an approval that is still the latest decision;
-- * a REVOKE withdraws exactly the latest decision of the same Claim, which must be an APPROVE of the same
--   assessment, so a decision is revoked at most once and never after it was superseded.
CREATE OR REPLACE FUNCTION claim_review_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  assessment_claim uuid;
  assessment_outcome text;
  assessment_fingerprint text;
  assessment_creator uuid;
  claim_creator uuid;
  latest_sequence integer;
  latest_decision text;
  latest_fingerprint text;
  target_claim uuid;
  target_decision text;
  target_assessment uuid;
  target_sequence integer;
BEGIN
  IF NEW."reviewed_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'claim_review_decision_time: a decision is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "claim_id", "outcome", "assembly_fingerprint", "created_by_user_id"
    INTO assessment_claim, assessment_outcome, assessment_fingerprint, assessment_creator
  FROM "claim_draft_assessments" WHERE "id" = NEW."draft_assessment_id";
  SELECT "created_by_user_id" INTO claim_creator FROM "claims" WHERE "id" = NEW."claim_id";
  IF assessment_claim IS NULL OR claim_creator IS NULL THEN
    RETURN NEW; -- the foreign keys report a missing Claim or assessment
  END IF;
  IF assessment_claim IS DISTINCT FROM NEW."claim_id" THEN
    RAISE EXCEPTION 'claim_review_decision_coherence: the draft assessment belongs to another claim'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "sequence", "decision_code", "approval_fingerprint" INTO latest_sequence, latest_decision, latest_fingerprint
  FROM "claim_review_events" WHERE "claim_id" = NEW."claim_id" ORDER BY "sequence" DESC LIMIT 1;
  IF NEW."sequence" IS DISTINCT FROM coalesce(latest_sequence, 0) + 1 THEN
    RAISE EXCEPTION 'claim_review_decision_sequence: the sequence is not the next one of this claim'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."decision_code" = 'APPROVE' THEN
    IF assessment_outcome IS DISTINCT FROM 'REVIEWABLE' THEN
      RAISE EXCEPTION 'claim_review_decision_coherence: only a REVIEWABLE draft assessment can be approved'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."approval_fingerprint" IS DISTINCT FROM assessment_fingerprint THEN
      RAISE EXCEPTION 'claim_review_decision_coherence: the approval fingerprint is not the assessment''s own'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."reviewer_user_id" = claim_creator OR NEW."reviewer_user_id" = assessment_creator THEN
      RAISE EXCEPTION 'claim_review_separation: the reviewer created the claim or the draft assessment'
        USING ERRCODE = 'check_violation';
    END IF;
    IF latest_decision = 'APPROVE' AND latest_fingerprint = NEW."approval_fingerprint" THEN
      RAISE EXCEPTION 'claim_review_decision_coherence: an approval of this exact fingerprint is already the latest decision'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."decision_code" = 'REVOKE' THEN
    SELECT "claim_id", "decision_code", "draft_assessment_id", "sequence"
      INTO target_claim, target_decision, target_assessment, target_sequence
    FROM "claim_review_events" WHERE "id" = NEW."referenced_approval_id";
    IF target_claim IS DISTINCT FROM NEW."claim_id" OR target_decision IS DISTINCT FROM 'APPROVE'
       OR target_assessment IS DISTINCT FROM NEW."draft_assessment_id" OR target_sequence IS DISTINCT FROM NEW."sequence" - 1 THEN
      RAISE EXCEPTION 'claim_review_decision_coherence: a revocation must withdraw this claim''s latest approval of the same assessment'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_review_events_insert_guard_trg
  BEFORE INSERT ON "claim_review_events"
  FOR EACH ROW EXECUTE FUNCTION claim_review_events_insert_guard();

-- §3 — a review decision is evidence: never updated, never deleted, including its decision, actor,
-- linkage and timestamps. A withdrawal is a new REVOKE; a correction is a new assessment and decision.
CREATE OR REPLACE FUNCTION claim_review_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_review_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_review_events"
  FOR EACH ROW EXECUTE FUNCTION claim_review_events_append_only();

-- There is deliberately no approval state or latest-approval pointer on the Claim, no ClaimSubmission,
-- payload, payload hash, DHPO/eClaimLink/XML, X12/NPI, transport, patient-share or HIE column, no review
-- session table and no free-text remark.
