-- A5.4 — Authorization Line Matching & Scope Validation
--
-- Migration Drift Guard: the generator emitted seven statements unrelated to A5.4 — four Better
-- Auth identifier defaults and three index removals it re-proposes on every generate. They were
-- removed by hand before this migration was ever applied, so the file below creates exactly one
-- table and touches nothing else.
--
-- Note on matching: there is deliberately no match-result table and no matched-activity, claim-line,
-- consumed-quantity or readiness column. Scope is compared against the Encounter every time it is
-- asked for, read-only, so a stored answer can never go stale against the facts it described.

-- CreateTable
CREATE TABLE "authorization_lines" (
    "id" UUID NOT NULL,
    "prior_authorization_version_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "service_id" UUID,
    "procedure_code_id" UUID,
    "diagnosis_code_id" UUID,
    "requested_qty" DECIMAL(18,4) NOT NULL,
    "approved_qty" DECIMAL(18,4),
    "unit_code" TEXT,
    "approved_from" DATE,
    "approved_through" DATE,
    "status" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "authorization_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "authorization_lines_prior_authorization_version_id_idx" ON "authorization_lines"("prior_authorization_version_id");

-- CreateIndex
CREATE INDEX "authorization_lines_service_id_idx" ON "authorization_lines"("service_id");

-- CreateIndex
CREATE INDEX "authorization_lines_procedure_code_id_idx" ON "authorization_lines"("procedure_code_id");

-- CreateIndex
CREATE INDEX "authorization_lines_diagnosis_code_id_idx" ON "authorization_lines"("diagnosis_code_id");

-- CreateIndex
CREATE INDEX "authorization_lines_status_idx" ON "authorization_lines"("status");

-- CreateIndex
CREATE UNIQUE INDEX "authorization_lines_prior_authorization_version_id_sequence_key" ON "authorization_lines"("prior_authorization_version_id", "sequence");

-- AddForeignKey
ALTER TABLE "authorization_lines" ADD CONSTRAINT "authorization_lines_prior_authorization_version_id_fkey" FOREIGN KEY ("prior_authorization_version_id") REFERENCES "prior_authorization_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_lines" ADD CONSTRAINT "authorization_lines_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_lines" ADD CONSTRAINT "authorization_lines_procedure_code_id_fkey" FOREIGN KEY ("procedure_code_id") REFERENCES "procedure_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_lines" ADD CONSTRAINT "authorization_lines_diagnosis_code_id_fkey" FOREIGN KEY ("diagnosis_code_id") REFERENCES "diagnosis_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "authorization_lines" ADD CONSTRAINT "authorization_lines_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A5.4 §11 — the line invariants are held by the database, not only by application validation, so a
-- row that reached this table by any other path still cannot contradict itself.
ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_sequence_positive_chk" CHECK ("sequence" >= 1);

-- A line must say WHAT was authorized. A diagnosis alone does not identify a service.
ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_identity_chk" CHECK (num_nonnulls("service_id", "procedure_code_id") >= 1);

ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_requested_qty_positive_chk" CHECK ("requested_qty" > 0);

-- Zero is an explicit answer ("approved for none"), distinct from NULL ("not supplied"). There is
-- deliberately no approved_qty <= requested_qty rule: payer semantics are external.
ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_approved_qty_nonnegative_chk" CHECK ("approved_qty" IS NULL OR "approved_qty" >= 0);

ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_unit_code_nonblank_chk" CHECK ("unit_code" IS NULL OR btrim("unit_code") <> '');

ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_approved_dates_order_chk"
  CHECK ("approved_from" IS NULL OR "approved_through" IS NULL OR "approved_through" >= "approved_from");

-- ACTIVE, EXPIRED, current and satisfied are deliberately absent: they are derived states, and A5.4
-- stores only what the source reported.
ALTER TABLE "authorization_lines"
  ADD CONSTRAINT "authorization_lines_status_chk"
  CHECK ("status" IN ('REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN'));

-- A5.4 §11 — an authorization line is reported scope for one exact version. Correcting it means a new
-- A5.3 version with a new line set, never an edit, so the database refuses both operations for every
-- writer, including a direct SQL session. This follows the A5.1, A5.2 and A5.3 append-only triggers.
CREATE OR REPLACE FUNCTION authorization_lines_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'authorization_lines is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authorization_lines_append_only_trg
  BEFORE UPDATE OR DELETE ON "authorization_lines"
  FOR EACH ROW EXECUTE FUNCTION authorization_lines_append_only();
