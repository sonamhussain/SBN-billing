-- A5.9 — Pre-Claim Readiness & A6 Handoff Contract
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A5.9 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly one table
-- and touches nothing else. The A6 handoff is a read-time DTO: there is no handoff, reason or
-- current-pointer table.

-- CreateTable
CREATE TABLE "pre_claim_readiness_assessments" (
    "id" UUID NOT NULL,
    "validation_run_id" UUID NOT NULL,
    "readiness_policy_version" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pre_claim_readiness_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pre_claim_readiness_assessments_validation_run_id_idx" ON "pre_claim_readiness_assessments"("validation_run_id");

-- CreateIndex
CREATE INDEX "pre_claim_readiness_assessments_state_assessed_at_idx" ON "pre_claim_readiness_assessments"("state", "assessed_at");

-- CreateIndex
CREATE UNIQUE INDEX "pre_claim_readiness_assessments_validation_run_id_readiness_key" ON "pre_claim_readiness_assessments"("validation_run_id", "readiness_policy_version");

-- AddForeignKey
ALTER TABLE "pre_claim_readiness_assessments" ADD CONSTRAINT "pre_claim_readiness_assessments_validation_run_id_fkey" FOREIGN KEY ("validation_run_id") REFERENCES "validation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_claim_readiness_assessments" ADD CONSTRAINT "pre_claim_readiness_assessments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.9 §6 — the readiness vocabulary and the policy label are held by the database too.
ALTER TABLE "pre_claim_readiness_assessments"
  ADD CONSTRAINT "pre_claim_readiness_assessments_state_chk" CHECK ("state" IN ('READY_FOR_REVIEW', 'RESTRICTED', 'BLOCKED'));

ALTER TABLE "pre_claim_readiness_assessments"
  ADD CONSTRAINT "pre_claim_readiness_assessments_policy_version_chk" CHECK (btrim("readiness_policy_version") <> '' AND "readiness_policy_version" = btrim("readiness_policy_version") AND char_length("readiness_policy_version") <= 96);

-- A5.9 §5/§6 — an assessment is historical business truth. The database refuses UPDATE and DELETE for
-- every writer, including a direct SQL session. A later validation is a new run with its own assessment.
CREATE OR REPLACE FUNCTION pre_claim_readiness_assessments_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'pre_claim_readiness_assessments is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pre_claim_readiness_assessments_append_only_trg
  BEFORE UPDATE OR DELETE ON "pre_claim_readiness_assessments"
  FOR EACH ROW EXECUTE FUNCTION pre_claim_readiness_assessments_append_only();
