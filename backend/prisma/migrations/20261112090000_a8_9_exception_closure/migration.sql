-- A8.9 — Internal Exception Closure & Historical Reconstruction
--
-- Creates exactly one append-only table: exception_closure_events (A8-CLOSURE-1, the human confirmation that one A8.1
-- exception intake's internal handling reached an approved terminal position), with its indexes, RESTRICT foreign keys,
-- a UNIQUE number per intake and at most one closure per intake (v1), CHECKs for the contract, the sequence, the one
-- controlled event and its exact shape (each basis kind with its own reason and owner contract), an insert guard that
-- holds database time, the parent intake's organization and Claim, the acting membership and its confirm permission,
-- the current A8.2 assignment, the intake's confirmed A8.7 decision, the confirmer's independence of the A8.7 requester
-- and decider, the A8.8 escalation position and the exact basis, the terminal state and the sequence, and append-only
-- and TRUNCATE triggers. No applied migration is modified and no existing table is altered.
--
-- CLOSED_INTERNAL is an internal process position only: never a clinical determination, payer adjudication, resolved
-- external claim, remittance, settlement, code-set compliance attestation or payment outcome. There is no reopening in
-- v1. No PHI, payload, source bytes, digest, amount or free text is stored.

-- CreateTable
CREATE TABLE "exception_closure_events" (
    "id" UUID NOT NULL,
    "exception_intake_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "resolution_decision_event_id" UUID NOT NULL,
    "basis_reference_kind" TEXT NOT NULL,
    "basis_reference_id" UUID NOT NULL,
    "basis_owner_contract_version" TEXT NOT NULL,
    "closure_reason_code" TEXT NOT NULL,
    "recorded_by_membership_id" UUID NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_closure_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_closure_events_organization_id_idx" ON "exception_closure_events"("organization_id");

-- CreateIndex
CREATE INDEX "exception_closure_events_claim_id_idx" ON "exception_closure_events"("claim_id");

-- CreateIndex
CREATE INDEX "exception_closure_events_resolution_decision_event_id_idx" ON "exception_closure_events"("resolution_decision_event_id");

-- CreateIndex
CREATE INDEX "exception_closure_events_basis_reference_id_idx" ON "exception_closure_events"("basis_reference_id");

-- CreateIndex
CREATE INDEX "exception_closure_events_recorded_by_membership_id_idx" ON "exception_closure_events"("recorded_by_membership_id");

-- CreateIndex
CREATE INDEX "exception_closure_events_recorded_by_user_id_idx" ON "exception_closure_events"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_closure_events_sequence_key" ON "exception_closure_events"("exception_intake_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "exception_closure_events_exception_intake_id_key" ON "exception_closure_events"("exception_intake_id");

-- AddForeignKey
ALTER TABLE "exception_closure_events" ADD CONSTRAINT "exception_closure_events_exception_intake_id_fkey" FOREIGN KEY ("exception_intake_id") REFERENCES "exception_intake_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_closure_events" ADD CONSTRAINT "exception_closure_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_closure_events" ADD CONSTRAINT "exception_closure_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_closure_events" ADD CONSTRAINT "exception_closure_events_resolution_decision_event_id_fkey" FOREIGN KEY ("resolution_decision_event_id") REFERENCES "exception_resolution_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_closure_events" ADD CONSTRAINT "exception_closure_events_recorded_by_membership_id_fkey" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_closure_events" ADD CONSTRAINT "exception_closure_events_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A8.9 §6, D1–D8) ----------------------------------------------------------

-- §4 — the fixed contract, a positive sequence, the one controlled event and its exact shape: the basis is the A8.7
-- confirmation itself (VERIFIED_INTERNAL_RESOLUTION, A8-RESOLUTION-DECISION-1) or the A8.8 return of a completed
-- escalation (TERMINAL_FOLLOWUP_REVIEWED, A8-ESCALATION-1). Each NOT NULL explicitly (a NULL must never pass an IN list).
ALTER TABLE "exception_closure_events"
  ADD CONSTRAINT "exception_closure_events_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-CLOSURE-1');

ALTER TABLE "exception_closure_events"
  ADD CONSTRAINT "exception_closure_events_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1);

ALTER TABLE "exception_closure_events"
  ADD CONSTRAINT "exception_closure_events_event_code_chk" CHECK ("event_code" IS NOT NULL AND "event_code" IN ('CONFIRM_INTERNAL_CLOSURE'));

ALTER TABLE "exception_closure_events"
  ADD CONSTRAINT "exception_closure_events_shape_chk" CHECK (
    "resolution_decision_event_id" IS NOT NULL AND "basis_reference_id" IS NOT NULL
    AND (("basis_reference_kind" IS NOT NULL AND "basis_reference_kind" = 'RESOLUTION_DECISION'
          AND "closure_reason_code" IS NOT NULL AND "closure_reason_code" = 'VERIFIED_INTERNAL_RESOLUTION'
          AND "basis_owner_contract_version" IS NOT NULL AND "basis_owner_contract_version" = 'A8-RESOLUTION-DECISION-1'
          AND "basis_reference_id" = "resolution_decision_event_id")
      OR ("basis_reference_kind" IS NOT NULL AND "basis_reference_kind" = 'ESCALATION_RETURN'
          AND "closure_reason_code" IS NOT NULL AND "closure_reason_code" = 'TERMINAL_FOLLOWUP_REVIEWED'
          AND "basis_owner_contract_version" IS NOT NULL AND "basis_owner_contract_version" = 'A8-ESCALATION-1'
          AND "basis_reference_id" <> "resolution_decision_event_id"))
  );

-- §3/§6 — a closure is recorded and created at the database's own transaction time; belongs to exactly the organization
-- and Claim of its parent intake; is recorded through the acting user's own membership of that organization, whose roles
-- grant exceptionClosure.confirm at this moment; and only while the intake's latest A8.2 triage event assigns it. There
-- is no earlier closure of the intake (terminal in v1) and it is numbered exactly 1.
--   The A8.7 position (§3): the named decision is a DECIDE_INTERNAL_RESOLUTION of exactly this intake, organization and
--   Claim with CONFIRM_INTERNAL_RESOLUTION, deciding the intake's one request; the confirmer's membership and user both
--   differ from the request's and the decision's (D1).
--   The A8.8 position (CL-01/CL-02): with no escalation of the intake the basis is the decision itself; with an
--   escalation returned to its owner for FOLLOWUP_RECORDED the basis is exactly that RETURN_TO_OWNER event; a return for
--   FURTHER_WORK_REQUIRED (v1) and an escalation that is not returned (awaiting acknowledgement or with follow-ups
--   active) refuse the closure.
-- The service checks the same facts first; this guard holds them against any direct write. The A1, A8.2, A8.7 and A8.8
-- tables are read here and never written.
CREATE OR REPLACE FUNCTION exception_closure_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  intake RECORD;
  latest_triage RECORD;
  decision RECORD;
  request RECORD;
  escalations integer := 0;
  return_id uuid := NULL;
  return_reason text := NULL;
  prior integer := 0;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_closure_time: a closure is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."organization_id", i."claim_id" INTO intake
  FROM "exception_intake_records" i WHERE i."id" = NEW."exception_intake_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing intake
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM intake."organization_id" OR NEW."claim_id" IS DISTINCT FROM intake."claim_id" THEN
    RAISE EXCEPTION 'exception_closure_coherence: the organization and Claim must be the parent intake''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."id" = NEW."recorded_by_membership_id" AND m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id"
  ) THEN
    RAISE EXCEPTION 'exception_closure_member: a closure is recorded through the acting user''s own membership of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM "membership_roles" mr
    JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
    WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" = 'exceptionClosure.confirm'
  ) THEN
    RAISE EXCEPTION 'exception_closure_independence: the confirmer''s roles must grant exceptionClosure.confirm'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."event_code" INTO latest_triage
  FROM "exception_triage_events" t WHERE t."exception_intake_id" = NEW."exception_intake_id" ORDER BY t."sequence" DESC LIMIT 1;
  IF NOT FOUND OR latest_triage."event_code" NOT IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') THEN
    RAISE EXCEPTION 'exception_closure_eligibility: the exception is not assigned; a closure is recorded only while it is'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) INTO prior FROM "exception_closure_events" c WHERE c."exception_intake_id" = NEW."exception_intake_id";
  IF prior > 0 THEN
    RAISE EXCEPTION 'exception_closure_transition: the exception is already CLOSED_INTERNAL (terminal in v1); no further closure is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."sequence" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'exception_closure_sequence: the closure of this intake is number 1'
      USING ERRCODE = 'check_violation';
  END IF;

  -- §3 — the intake's confirmed A8.7 decision and its request.
  SELECT d."id", d."request_event_id", d."decision_code", d."recorded_by_membership_id", d."recorded_by_user_id" INTO decision
  FROM "exception_resolution_events" d
  WHERE d."id" = NEW."resolution_decision_event_id" AND d."exception_intake_id" = NEW."exception_intake_id"
    AND d."organization_id" = NEW."organization_id" AND d."claim_id" = NEW."claim_id" AND d."event_code" = 'DECIDE_INTERNAL_RESOLUTION';
  IF NOT FOUND OR decision."decision_code" IS DISTINCT FROM 'CONFIRM_INTERNAL_RESOLUTION' THEN
    RAISE EXCEPTION 'exception_closure_eligibility: a closure names exactly the intake''s confirmed A8.7 internal resolution'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT r."recorded_by_membership_id", r."recorded_by_user_id" INTO request
  FROM "exception_resolution_events" r
  WHERE r."id" = decision."request_event_id" AND r."exception_intake_id" = NEW."exception_intake_id" AND r."event_code" = 'REQUEST_INTERNAL_RESOLUTION';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exception_closure_eligibility: the confirmed A8.7 decision does not decide a request of this intake'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."recorded_by_membership_id" IN (decision."recorded_by_membership_id", request."recorded_by_membership_id")
    OR NEW."recorded_by_user_id" IN (decision."recorded_by_user_id", request."recorded_by_user_id") THEN
    RAISE EXCEPTION 'exception_closure_independence: an exception is never closed by its A8.7 resolution''s own requester or decider'
      USING ERRCODE = 'check_violation';
  END IF;

  -- CL-01/CL-02 — the A8.8 position and the exact basis.
  SELECT count(*) INTO escalations FROM "exception_escalation_events" e WHERE e."exception_intake_id" = NEW."exception_intake_id";
  SELECT e."id", e."return_reason_code" INTO return_id, return_reason FROM "exception_escalation_events" e
  WHERE e."exception_intake_id" = NEW."exception_intake_id" AND e."organization_id" = NEW."organization_id" AND e."claim_id" = NEW."claim_id" AND e."event_code" = 'RETURN_TO_OWNER';
  IF escalations = 0 THEN
    IF NEW."basis_reference_kind" IS DISTINCT FROM 'RESOLUTION_DECISION' OR NEW."basis_reference_id" IS DISTINCT FROM NEW."resolution_decision_event_id" THEN
      RAISE EXCEPTION 'exception_closure_eligibility: without an escalation the basis is exactly the A8.7 confirmation'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF return_id IS NULL THEN
    RAISE EXCEPTION 'exception_closure_eligibility: the intake''s A8.8 escalation is still outstanding; the exception is not closed'
      USING ERRCODE = 'check_violation';
  ELSIF return_reason IS DISTINCT FROM 'FOLLOWUP_RECORDED' THEN
    RAISE EXCEPTION 'exception_closure_eligibility: the intake''s A8.8 escalation was returned for further work; the exception is not closed in v1'
      USING ERRCODE = 'check_violation';
  ELSIF NEW."basis_reference_kind" IS DISTINCT FROM 'ESCALATION_RETURN' OR NEW."basis_reference_id" IS DISTINCT FROM return_id THEN
    RAISE EXCEPTION 'exception_closure_eligibility: after a completed escalation the basis is exactly its A8.8 return'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_closure_events_insert_guard_trg
  BEFORE INSERT ON "exception_closure_events"
  FOR EACH ROW EXECUTE FUNCTION exception_closure_events_insert_guard();

-- §6 — closure events are history: never updated (not even a no-op update), never deleted and never wiped in bulk
-- (a TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_closure_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_closure_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_closure_events"
  FOR EACH ROW EXECUTE FUNCTION exception_closure_append_only();

CREATE TRIGGER exception_closure_events_no_truncate_trg
  BEFORE TRUNCATE ON "exception_closure_events"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_closure_append_only();

-- There is deliberately no status, closed flag, current/latest, reopen, SLA, queue, amount, currency, payer, payment,
-- narrative, attachment, payload, digest or export column, no queue or job table, and no new column on any A1–A8.8 or
-- CRG table.
