-- A8.7 — Internal Exception Resolution Decision
--
-- Creates exactly one append-only table: exception_resolution_events (A8-RESOLUTION-DECISION-1, the numbered
-- request-and-decision history of one A8.1 exception intake against its one independently verified A8.6 work record),
-- with its indexes, RESTRICT foreign keys, a UNIQUE number per intake and a UNIQUE decision per request, CHECKs for the
-- contract, the sequence, the two controlled events and each event's exact shape, an insert guard that holds database
-- time, the parent intake's organization and Claim, the acting membership, the current A8.2 assignment and the
-- requester's or decider's permission, the verified A8.6 basis on the intake's approved A8.5 plan, the pending request,
-- the decider's independence, the terminal states and a contiguous sequence, and append-only and TRUNCATE triggers. No
-- applied migration is modified and no existing table is altered.
--
-- RESOLVED_INTERNAL is an internal decision only: never an execution, correction, closure, escalation, payer outcome or
-- payment. RETURNED_FOR_REWORK is terminal in v1. No PHI, payload, source bytes, digest, amount or free text is stored.

-- CreateTable
CREATE TABLE "exception_resolution_events" (
    "id" UUID NOT NULL,
    "exception_intake_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "verification_event_id" UUID,
    "request_event_id" UUID,
    "reason_code" TEXT,
    "decision_code" TEXT,
    "return_reason_code" TEXT,
    "recorded_by_membership_id" UUID NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_resolution_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_resolution_events_organization_id_idx" ON "exception_resolution_events"("organization_id");

-- CreateIndex
CREATE INDEX "exception_resolution_events_claim_id_idx" ON "exception_resolution_events"("claim_id");

-- CreateIndex
CREATE INDEX "exception_resolution_events_verification_event_id_idx" ON "exception_resolution_events"("verification_event_id");

-- CreateIndex
CREATE INDEX "exception_resolution_events_recorded_by_membership_id_idx" ON "exception_resolution_events"("recorded_by_membership_id");

-- CreateIndex
CREATE INDEX "exception_resolution_events_recorded_by_user_id_idx" ON "exception_resolution_events"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_resolution_events_sequence_key" ON "exception_resolution_events"("exception_intake_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "exception_resolution_events_request_event_id_key" ON "exception_resolution_events"("request_event_id");

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_exception_intake_id_fkey" FOREIGN KEY ("exception_intake_id") REFERENCES "exception_intake_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_verification_event_id_fkey" FOREIGN KEY ("verification_event_id") REFERENCES "exception_remediation_work_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_request_event_id_fkey" FOREIGN KEY ("request_event_id") REFERENCES "exception_resolution_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_recorded_by_membership_id_fkey" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_resolution_events" ADD CONSTRAINT "exception_resolution_events_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A8.7 §5, D2–D8) ----------------------------------------------------------

-- §3/§5 — the fixed contract, a positive sequence, the two controlled events and the exact shape of each: a request
-- carries one A8.6 verification and the controlled reason, and nothing else; a decision carries one request and a
-- controlled decision code, with a controlled return reason exactly when it returns the request, and nothing else. Each
-- NOT NULL explicitly (a NULL must never pass an IN list).
ALTER TABLE "exception_resolution_events"
  ADD CONSTRAINT "exception_resolution_events_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-RESOLUTION-DECISION-1');

ALTER TABLE "exception_resolution_events"
  ADD CONSTRAINT "exception_resolution_events_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1);

ALTER TABLE "exception_resolution_events"
  ADD CONSTRAINT "exception_resolution_events_event_code_chk" CHECK (
    "event_code" IS NOT NULL AND "event_code" IN ('REQUEST_INTERNAL_RESOLUTION', 'DECIDE_INTERNAL_RESOLUTION')
  );

ALTER TABLE "exception_resolution_events"
  ADD CONSTRAINT "exception_resolution_events_shape_chk" CHECK (
    ("event_code" = 'REQUEST_INTERNAL_RESOLUTION'
      AND "verification_event_id" IS NOT NULL
      AND "reason_code" IS NOT NULL AND "reason_code" IN ('VERIFIED_INTERNAL_WORK')
      AND "request_event_id" IS NULL AND "decision_code" IS NULL AND "return_reason_code" IS NULL)
    OR ("event_code" = 'DECIDE_INTERNAL_RESOLUTION'
      AND "request_event_id" IS NOT NULL
      AND "verification_event_id" IS NULL AND "reason_code" IS NULL
      AND "decision_code" IS NOT NULL
      AND (("decision_code" = 'CONFIRM_INTERNAL_RESOLUTION' AND "return_reason_code" IS NULL)
        OR ("decision_code" = 'RETURN_FOR_REWORK' AND "return_reason_code" IS NOT NULL
            AND "return_reason_code" IN ('INSUFFICIENT_SUPPORT', 'SOURCE_INTEGRITY_CONCERN', 'ADDITIONAL_WORK_REQUIRED'))))
  );

-- §4/§5 — an event is recorded and created at the database's own transaction time; belongs to exactly the
-- organization and Claim of its parent intake; is recorded through the acting user's own membership of that
-- organization; and only while the intake's latest A8.2 triage event assigns the exception. Its stored resolution
-- history must be numbered 1..N and replay legally, and it is numbered exactly one more; after a decision (confirmed or
-- returned: both terminal in v1) nothing further is recorded.
--   The verified basis (D4): an A8.6 VERIFY_WORK_REPORT of exactly this intake, organization and Claim with
--   verification code EVIDENCE_SUPPORTED, on an A8.6 history that holds no other verification, whose approved plan is
--   a PROPOSE_ACTION of this intake that an A8.5 APPROVE_PROPOSAL review approved.
--   A request: the exception is assigned to exactly the acting membership, whose roles grant exceptionTriage.record (the
--   A8.2 assignee policy) and exceptionResolution.request at this moment; it names exactly the verified basis; and no
--   request awaits a decision.
--   A decision: the acting membership's roles grant exceptionResolution.decide at this moment; it names exactly the
--   request that awaits a decision; the decider's membership and user both differ from the requester's (D5); and the
--   request's recorded basis is still the intake's verified basis (D6).
-- The service checks the same facts first; this guard holds them against any direct write. The A8.2, A8.5 and A8.6
-- tables are read here and never written.
CREATE OR REPLACE FUNCTION exception_resolution_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  intake RECORD;
  latest_triage RECORD;
  prior RECORD;
  expected integer := 1;
  pending_id uuid := NULL;
  pending_membership uuid := NULL;
  pending_user uuid := NULL;
  pending_verification uuid := NULL;
  terminal boolean := false;
  basis_id uuid := NULL;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_resolution_time: a resolution event is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."organization_id", i."claim_id" INTO intake
  FROM "exception_intake_records" i WHERE i."id" = NEW."exception_intake_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing intake
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM intake."organization_id" OR NEW."claim_id" IS DISTINCT FROM intake."claim_id" THEN
    RAISE EXCEPTION 'exception_resolution_coherence: the organization and Claim must be the parent intake''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."id" = NEW."recorded_by_membership_id" AND m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id"
  ) THEN
    RAISE EXCEPTION 'exception_resolution_member: a resolution event is recorded through the acting user''s own membership of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."event_code", t."assigned_member_id" INTO latest_triage
  FROM "exception_triage_events" t WHERE t."exception_intake_id" = NEW."exception_intake_id" ORDER BY t."sequence" DESC LIMIT 1;
  IF NOT FOUND OR latest_triage."event_code" NOT IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') THEN
    RAISE EXCEPTION 'exception_resolution_transition: the exception is not assigned; a resolution is requested and decided only while it is'
      USING ERRCODE = 'check_violation';
  END IF;

  -- D4 — the intake's one verified A8.6 work record on its approved A8.5 plan (A8.6 v1 verification is terminal, so
  -- there is at most one verification; any other A8.6 verification of the intake makes the basis unprovable).
  SELECT v."id" INTO basis_id
  FROM "exception_remediation_work_events" v
  JOIN "exception_remediation_events" p ON p."id" = v."approved_proposal_event_id" AND p."event_code" = 'PROPOSE_ACTION'
    AND p."exception_intake_id" = v."exception_intake_id" AND p."organization_id" = v."organization_id" AND p."claim_id" = v."claim_id"
  WHERE v."exception_intake_id" = NEW."exception_intake_id" AND v."organization_id" = NEW."organization_id" AND v."claim_id" = NEW."claim_id"
    AND v."event_code" = 'VERIFY_WORK_REPORT' AND v."verification_code" = 'EVIDENCE_SUPPORTED'
    AND EXISTS (
      SELECT 1 FROM "exception_remediation_events" r
      WHERE r."proposal_event_id" = p."id" AND r."event_code" = 'REVIEW_ACTION' AND r."decision_code" = 'APPROVE_PROPOSAL' AND r."exception_intake_id" = NEW."exception_intake_id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "exception_remediation_work_events" o
      WHERE o."exception_intake_id" = NEW."exception_intake_id" AND o."event_code" = 'VERIFY_WORK_REPORT' AND o."id" <> v."id"
    );

  -- The stored history, replayed: numbered 1..N, the pending request and whether a decision ended it.
  FOR prior IN
    SELECT e."id", e."sequence", e."event_code", e."verification_event_id", e."recorded_by_membership_id", e."recorded_by_user_id"
    FROM "exception_resolution_events" e WHERE e."exception_intake_id" = NEW."exception_intake_id" ORDER BY e."sequence"
  LOOP
    IF prior."sequence" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'exception_resolution_sequence: the stored history of the intake is not numbered 1..N'
        USING ERRCODE = 'check_violation';
    END IF;
    IF prior."event_code" = 'REQUEST_INTERNAL_RESOLUTION' THEN
      pending_id := prior."id"; pending_membership := prior."recorded_by_membership_id"; pending_user := prior."recorded_by_user_id";
      pending_verification := prior."verification_event_id";
    ELSE
      terminal := true; pending_id := NULL;
    END IF;
    expected := expected + 1;
  END LOOP;
  IF NEW."sequence" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'exception_resolution_sequence: the next event of this intake is number %', expected
      USING ERRCODE = 'check_violation';
  END IF;
  IF terminal THEN
    RAISE EXCEPTION 'exception_resolution_transition: the resolution request of this intake was decided (confirmed or returned, both terminal in v1); no further event is recorded'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" = 'REQUEST_INTERNAL_RESOLUTION' THEN
    IF latest_triage."assigned_member_id" IS DISTINCT FROM NEW."recorded_by_membership_id" OR (
      SELECT count(DISTINCT p."code")
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" IN ('exceptionTriage.record', 'exceptionResolution.request')
    ) <> 2 THEN
      RAISE EXCEPTION 'exception_resolution_assignee: only the current A8.2 assignee holding exceptionTriage.record and exceptionResolution.request requests a resolution'
        USING ERRCODE = 'check_violation';
    END IF;
    IF basis_id IS NULL OR NEW."verification_event_id" IS DISTINCT FROM basis_id THEN
      RAISE EXCEPTION 'exception_resolution_basis: a request names exactly the intake''s EVIDENCE_SUPPORTED A8.6 verification on its approved A8.5 plan'
        USING ERRCODE = 'check_violation';
    END IF;
    IF pending_id IS NOT NULL THEN
      RAISE EXCEPTION 'exception_resolution_transition: a resolution request of this intake already awaits a decision'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" = 'exceptionResolution.decide'
    ) THEN
      RAISE EXCEPTION 'exception_resolution_reviewer: the decider''s roles must grant exceptionResolution.decide'
        USING ERRCODE = 'check_violation';
    END IF;
    IF pending_id IS NULL OR NEW."request_event_id" IS DISTINCT FROM pending_id THEN
      RAISE EXCEPTION 'exception_resolution_transition: a decision names exactly the resolution request that awaits a decision'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recorded_by_membership_id" = pending_membership OR NEW."recorded_by_user_id" = pending_user THEN
      RAISE EXCEPTION 'exception_resolution_reviewer: a resolution request is never decided by its own requester'
        USING ERRCODE = 'check_violation';
    END IF;
    IF basis_id IS NULL OR pending_verification IS DISTINCT FROM basis_id THEN
      RAISE EXCEPTION 'exception_resolution_basis: the request''s recorded A8.6 verification is no longer the intake''s verified basis'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_resolution_events_insert_guard_trg
  BEFORE INSERT ON "exception_resolution_events"
  FOR EACH ROW EXECUTE FUNCTION exception_resolution_events_insert_guard();

-- §5 — resolution events are history: never updated (not even a no-op update), never deleted and never wiped in bulk
-- (a TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_resolution_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_resolution_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_resolution_events"
  FOR EACH ROW EXECUTE FUNCTION exception_resolution_append_only();

CREATE TRIGGER exception_resolution_events_no_truncate_trg
  BEFORE TRUNCATE ON "exception_resolution_events"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_resolution_append_only();

-- There is deliberately no status, current/latest, execution, correction, closure, SLA, escalation, amount, currency,
-- payer, narrative, attachment, payload, digest or export column, no queue or job table, and no new column on any
-- A1–A8.6 or CRG table.
