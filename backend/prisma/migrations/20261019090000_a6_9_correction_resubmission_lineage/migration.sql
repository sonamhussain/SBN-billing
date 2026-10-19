-- A6.9 — Correction & Resubmission Lineage
--
-- Creates exactly one append-only table: claim_correction_links (A6-CORRECTION-1), the immutable correction
-- links between two distinct A6.7 freezes of one Claim, with its indexes, CHECKs, lineage guard and
-- append-only trigger. No applied migration is modified, no existing table is altered (claims and
-- claim_freezes keep every column), and the generated statements below were produced schema-to-schema with
-- no unrelated drift.
--
-- A link is a historical traceability fact only: it is not an edit, a replacement, an approval, a
-- resubmission or a payer event, and it never changes either freeze, its bytes, evidence package, approval
-- or A6.8 lifecycle. There is no status, current or latest pointer.

-- CreateTable
CREATE TABLE "claim_correction_links" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "prior_submission_id" UUID NOT NULL,
    "corrected_submission_id" UUID NOT NULL,
    "reason_code" TEXT NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contract_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_correction_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claim_correction_links_prior_submission_id_key" ON "claim_correction_links"("prior_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_correction_links_corrected_submission_id_key" ON "claim_correction_links"("corrected_submission_id");

-- CreateIndex
CREATE INDEX "claim_correction_links_claim_id_idx" ON "claim_correction_links"("claim_id");

-- CreateIndex
CREATE INDEX "claim_correction_links_recorded_by_user_id_idx" ON "claim_correction_links"("recorded_by_user_id");

-- AddForeignKey
ALTER TABLE "claim_correction_links" ADD CONSTRAINT "claim_correction_links_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_correction_links" ADD CONSTRAINT "claim_correction_links_prior_submission_id_fkey" FOREIGN KEY ("prior_submission_id") REFERENCES "claim_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_correction_links" ADD CONSTRAINT "claim_correction_links_corrected_submission_id_fkey" FOREIGN KEY ("corrected_submission_id") REFERENCES "claim_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_correction_links" ADD CONSTRAINT "claim_correction_links_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A6.9 §4, §5) -------------------------------------------------------------

-- §4 — a link carries its fixed contract, one of the five controlled reason codes (never free text, never
-- null) and two distinct freezes. The two UNIQUE keys above make the history linear: a freeze is the prior
-- of at most one link (no fork) and the correction of at most one link (no join).
ALTER TABLE "claim_correction_links"
  ADD CONSTRAINT "claim_correction_links_contract_version_chk" CHECK ("contract_version" = 'A6-CORRECTION-1');

ALTER TABLE "claim_correction_links"
  ADD CONSTRAINT "claim_correction_links_reason_chk" CHECK (
    "reason_code" IS NOT NULL AND "reason_code" IN ('CORRECTED_CODING', 'CORRECTED_SOURCE', 'CORRECTED_PRICING', 'CORRECTED_DOCUMENTATION', 'INTERNAL_OTHER')
  );

ALTER TABLE "claim_correction_links"
  ADD CONSTRAINT "claim_correction_links_distinct_chk" CHECK ("prior_submission_id" <> "corrected_submission_id");

-- §5 — the database is the backstop behind every service check, so a direct INSERT cannot bypass it. A link:
-- * is recorded at the database's own transaction time (nothing backdated or postdated);
-- * joins two freezes that both belong to the link's own Claim (a cross-Claim, and therefore cross-tenant,
--   link is refused) and rest on distinct draft assessments (a correction is a new assessed draft);
-- * points forward in time: the correction was frozen strictly after the freeze it corrects (an equal
--   instant is ambiguous and refused; identifiers are never a clock);
-- * extends the Claim's single chain at its tail: when the Claim already has links, the prior is the one
--   correction that corrects nothing yet, and the new correction is not already in the chain. Together with
--   the UNIQUE keys this refuses forks, joins, cycles and a second chain on one Claim.
CREATE OR REPLACE FUNCTION claim_correction_links_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  prior_claim uuid;
  prior_assessment uuid;
  prior_frozen timestamptz;
  corrected_claim uuid;
  corrected_assessment uuid;
  corrected_frozen timestamptz;
  link_count integer;
  chain_tail uuid;
  tail_count integer;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'claim_correction_time: a correction link is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "claim_id", "draft_assessment_id", "frozen_at" INTO prior_claim, prior_assessment, prior_frozen
  FROM "claim_freezes" WHERE "id" = NEW."prior_submission_id";
  SELECT "claim_id", "draft_assessment_id", "frozen_at" INTO corrected_claim, corrected_assessment, corrected_frozen
  FROM "claim_freezes" WHERE "id" = NEW."corrected_submission_id";
  IF prior_claim IS NULL OR corrected_claim IS NULL THEN
    RETURN NEW; -- the foreign keys report a missing freeze
  END IF;
  IF prior_claim IS DISTINCT FROM NEW."claim_id" OR corrected_claim IS DISTINCT FROM NEW."claim_id" THEN
    RAISE EXCEPTION 'claim_correction_coherence: both freezes must belong to the link''s claim'
      USING ERRCODE = 'check_violation';
  END IF;
  IF prior_assessment = corrected_assessment THEN
    RAISE EXCEPTION 'claim_correction_coherence: a correction must rest on a different draft assessment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (corrected_frozen > prior_frozen) THEN
    RAISE EXCEPTION 'claim_correction_chronology: the correction must be frozen strictly after the freeze it corrects'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO link_count FROM "claim_correction_links" WHERE "claim_id" = NEW."claim_id";
  IF link_count > 0 THEN
    SELECT count(*), min(l."corrected_submission_id"::text)::uuid INTO tail_count, chain_tail
    FROM "claim_correction_links" l
    WHERE l."claim_id" = NEW."claim_id"
      AND NOT EXISTS (SELECT 1 FROM "claim_correction_links" n WHERE n."prior_submission_id" = l."corrected_submission_id");
    IF tail_count <> 1 OR NEW."prior_submission_id" IS DISTINCT FROM chain_tail THEN
      RAISE EXCEPTION 'claim_correction_chain: the chain grows only at its tail'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "claim_correction_links"
      WHERE "claim_id" = NEW."claim_id" AND (NEW."corrected_submission_id" IN ("prior_submission_id", "corrected_submission_id"))
    ) THEN
      RAISE EXCEPTION 'claim_correction_chain: the correction is already part of this claim''s chain'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_correction_links_insert_guard_trg
  BEFORE INSERT ON "claim_correction_links"
  FOR EACH ROW EXECUTE FUNCTION claim_correction_links_insert_guard();

-- §4/§5 — a correction link is evidence: never updated (not even a no-op update) and never deleted.
CREATE OR REPLACE FUNCTION claim_correction_links_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_correction_links_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_correction_links"
  FOR EACH ROW EXECUTE FUNCTION claim_correction_links_append_only();

-- There is deliberately no status, current or latest pointer, resubmission attempt, payer reference,
-- transport field, free-text reason or new column on claims or claim_freezes.
