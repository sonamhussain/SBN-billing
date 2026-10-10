-- A6.1 — Claim Foundation & A5 Handoff Binding
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A6.1 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly one table
-- and touches nothing else. There is no claim line, price, lifecycle, approval, payload, submission or
-- transport table.

-- CreateTable
CREATE TABLE "claims" (
    "id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "pre_claim_readiness_assessment_id" UUID NOT NULL,
    "claim_contract_version" TEXT NOT NULL,
    "handoff_schema_version" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claims_pre_claim_readiness_assessment_id_key" ON "claims"("pre_claim_readiness_assessment_id");

-- CreateIndex
CREATE INDEX "claims_encounter_id_created_at_idx" ON "claims"("encounter_id", "created_at");

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_pre_claim_readiness_assessment_id_fkey" FOREIGN KEY ("pre_claim_readiness_assessment_id") REFERENCES "pre_claim_readiness_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claims" ADD CONSTRAINT "claims_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A6.1 §5/§7 — the contract labels are server-owned and held by the database too. A later Claim
-- contract arrives with its own migration; an A6-CLAIM-1 row is never reinterpreted.
ALTER TABLE "claims"
  ADD CONSTRAINT "claims_claim_contract_version_chk" CHECK (
    "claim_contract_version" = 'A6-CLAIM-1'
    AND btrim("claim_contract_version") <> ''
    AND "claim_contract_version" = btrim("claim_contract_version")
    AND char_length("claim_contract_version") <= 96
  );

ALTER TABLE "claims"
  ADD CONSTRAINT "claims_handoff_schema_version_chk" CHECK (
    "handoff_schema_version" = 'PreClaimA6HandoffV1'
    AND btrim("handoff_schema_version") <> ''
    AND "handoff_schema_version" = btrim("handoff_schema_version")
    AND char_length("handoff_schema_version") <= 96
  );

-- A6.1 §7/§14 — a Claim may only bind an assessment of its own Encounter. The assessment's run decides
-- the Encounter; a direct insert pairing a Claim with another Encounter's assessment is refused.
CREATE OR REPLACE FUNCTION claims_binding_coherence()
RETURNS TRIGGER AS $$
DECLARE
  run_encounter_id uuid;
BEGIN
  SELECT run."encounter_id" INTO run_encounter_id
  FROM "pre_claim_readiness_assessments" assessment
  JOIN "validation_runs" run ON run."id" = assessment."validation_run_id"
  WHERE assessment."id" = NEW."pre_claim_readiness_assessment_id";
  IF run_encounter_id IS DISTINCT FROM NEW."encounter_id" THEN
    RAISE EXCEPTION 'claims_binding_coherence: the readiness assessment does not belong to the claim encounter'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_binding_coherence_trg
  BEFORE INSERT ON "claims"
  FOR EACH ROW EXECUTE FUNCTION claims_binding_coherence();

-- A6.1 §7/§14 — the source binding is identity. It is never changed and a Claim is never deleted. This
-- guards the identity columns only, not the whole row: later A6 lifecycle columns are governed by
-- their own owner and are not blanket-refused here.
CREATE OR REPLACE FUNCTION claims_identity_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claims cannot be deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."encounter_id" IS DISTINCT FROM OLD."encounter_id"
     OR NEW."pre_claim_readiness_assessment_id" IS DISTINCT FROM OLD."pre_claim_readiness_assessment_id"
     OR NEW."claim_contract_version" IS DISTINCT FROM OLD."claim_contract_version"
     OR NEW."handoff_schema_version" IS DISTINCT FROM OLD."handoff_schema_version"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'claims identity and source binding are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claims_identity_guard_trg
  BEFORE UPDATE OR DELETE ON "claims"
  FOR EACH ROW EXECUTE FUNCTION claims_identity_guard();
