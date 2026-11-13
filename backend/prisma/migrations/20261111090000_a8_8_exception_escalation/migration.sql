-- A8.8 — Exception Escalation & Follow-up Governance
--
-- Creates exactly one append-only table: exception_escalation_events (A8-ESCALATION-1, the numbered internal-handoff
-- history of one A8.1 exception intake: one escalation to a nominated member, its acknowledgement, typed follow-ups
-- citing exact A8.3/A8.6 records of the intake, and a return to the owner), with its indexes, RESTRICT foreign keys, a
-- UNIQUE number per intake, one escalation, acknowledgement and return per intake, one (code, source) per follow-up,
-- CHECKs for the contract, the sequence, the four controlled events and each event's exact shape, an insert guard that
-- holds database time, the parent intake's organization and Claim, the acting membership, the current A8.2 assignment,
-- the A8.7 resolution state, each actor's permission and role in the cycle, the nominated member's eligibility, the
-- exact cited source, independence, the terminal state and a contiguous sequence, and append-only and TRUNCATE
-- triggers. No applied migration is modified and no existing table is altered.
--
-- Escalation is an INTERNAL HANDOFF only: never an emergency or clinical priority, payer status, resolution, closure,
-- reassignment, execution, correction or payment. RETURNED_TO_OWNER is terminal in v1. No PHI, payload, source bytes,
-- digest, amount or free text is stored.

-- CreateTable
CREATE TABLE "exception_escalation_events" (
    "id" UUID NOT NULL,
    "exception_intake_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "reason_code" TEXT,
    "target_member_id" UUID,
    "escalation_event_id" UUID,
    "acknowledgement_event_id" UUID,
    "followup_code" TEXT,
    "source_event_id" UUID,
    "source_event_kind" TEXT,
    "return_reason_code" TEXT,
    "recorded_by_membership_id" UUID NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_escalation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_escalation_events_organization_id_idx" ON "exception_escalation_events"("organization_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_claim_id_idx" ON "exception_escalation_events"("claim_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_target_member_id_idx" ON "exception_escalation_events"("target_member_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_escalation_event_id_idx" ON "exception_escalation_events"("escalation_event_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_acknowledgement_event_id_idx" ON "exception_escalation_events"("acknowledgement_event_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_source_event_id_idx" ON "exception_escalation_events"("source_event_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_recorded_by_membership_id_idx" ON "exception_escalation_events"("recorded_by_membership_id");

-- CreateIndex
CREATE INDEX "exception_escalation_events_recorded_by_user_id_idx" ON "exception_escalation_events"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_escalation_events_sequence_key" ON "exception_escalation_events"("exception_intake_id", "sequence");

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_exception_intake_id_fkey" FOREIGN KEY ("exception_intake_id") REFERENCES "exception_intake_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_target_member_id_fkey" FOREIGN KEY ("target_member_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_escalation_event_id_fkey" FOREIGN KEY ("escalation_event_id") REFERENCES "exception_escalation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_acknowledgement_event_id_fkey" FOREIGN KEY ("acknowledgement_event_id") REFERENCES "exception_escalation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_recorded_by_membership_id_fkey" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_escalation_events" ADD CONSTRAINT "exception_escalation_events_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A8.8 §5, D1–D8) ----------------------------------------------------------

-- D8 — one escalation cycle per intake in v1: at most one escalation, one acknowledgement and one return; and a
-- follow-up is a distinct step: the same code citing the same record is recorded once (T046, T070).
CREATE UNIQUE INDEX "exception_escalation_events_one_cycle_key" ON "exception_escalation_events"("exception_intake_id", "event_code")
  WHERE "event_code" IN ('ESCALATE_FOR_REVIEW', 'ACKNOWLEDGE_ESCALATION', 'RETURN_TO_OWNER');

CREATE UNIQUE INDEX "exception_escalation_events_followup_key" ON "exception_escalation_events"("exception_intake_id", "followup_code", "source_event_id")
  WHERE "event_code" = 'RECORD_FOLLOWUP';

-- §3/§5 — the fixed contract, a positive sequence, the four controlled events and the exact shape of each: every event
-- carries exactly its own controlled attributes and nothing else. Each NOT NULL explicitly (a NULL must never pass an
-- IN list).
ALTER TABLE "exception_escalation_events"
  ADD CONSTRAINT "exception_escalation_events_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-ESCALATION-1');

ALTER TABLE "exception_escalation_events"
  ADD CONSTRAINT "exception_escalation_events_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1);

ALTER TABLE "exception_escalation_events"
  ADD CONSTRAINT "exception_escalation_events_event_code_chk" CHECK (
    "event_code" IS NOT NULL AND "event_code" IN ('ESCALATE_FOR_REVIEW', 'ACKNOWLEDGE_ESCALATION', 'RECORD_FOLLOWUP', 'RETURN_TO_OWNER')
  );

ALTER TABLE "exception_escalation_events"
  ADD CONSTRAINT "exception_escalation_events_shape_chk" CHECK (
    ("event_code" = 'ESCALATE_FOR_REVIEW'
      AND "reason_code" IS NOT NULL AND "reason_code" IN ('NEEDS_SUPERVISOR_REVIEW', 'EVIDENCE_INCOMPLETE', 'POLICY_GUIDANCE_REQUIRED')
      AND "target_member_id" IS NOT NULL
      AND "escalation_event_id" IS NULL AND "acknowledgement_event_id" IS NULL AND "followup_code" IS NULL
      AND "source_event_id" IS NULL AND "source_event_kind" IS NULL AND "return_reason_code" IS NULL)
    OR ("event_code" = 'ACKNOWLEDGE_ESCALATION'
      AND "escalation_event_id" IS NOT NULL
      AND "reason_code" IS NULL AND "target_member_id" IS NULL AND "acknowledgement_event_id" IS NULL AND "followup_code" IS NULL
      AND "source_event_id" IS NULL AND "source_event_kind" IS NULL AND "return_reason_code" IS NULL)
    OR ("event_code" = 'RECORD_FOLLOWUP'
      AND "acknowledgement_event_id" IS NOT NULL
      AND "followup_code" IS NOT NULL AND "followup_code" IN ('SOURCE_RECHECK_RECORDED', 'ADDITIONAL_INFORMATION_REQUESTED', 'INTERNAL_POLICY_REVIEWED')
      AND "source_event_id" IS NOT NULL
      AND "source_event_kind" IS NOT NULL AND "source_event_kind" IN ('INVESTIGATION_EVIDENCE_LINK', 'INVESTIGATION_FINDING', 'WORK_REPORT', 'WORK_VERIFICATION')
      AND "reason_code" IS NULL AND "target_member_id" IS NULL AND "escalation_event_id" IS NULL AND "return_reason_code" IS NULL)
    OR ("event_code" = 'RETURN_TO_OWNER'
      AND "escalation_event_id" IS NOT NULL
      AND "return_reason_code" IS NOT NULL AND "return_reason_code" IN ('FOLLOWUP_RECORDED', 'FURTHER_WORK_REQUIRED')
      AND "reason_code" IS NULL AND "target_member_id" IS NULL AND "acknowledgement_event_id" IS NULL AND "followup_code" IS NULL
      AND "source_event_id" IS NULL AND "source_event_kind" IS NULL)
  );

-- §5 — an event is recorded and created at the database's own transaction time; belongs to exactly the organization
-- and Claim of its parent intake; is recorded through the acting user's own membership of that organization; and only
-- while the intake's latest A8.2 triage event assigns the exception. D1: nothing is recorded while an A8.7 resolution
-- request awaits a decision, or once A8.7 confirmed the internal resolution (RESOLVED_INTERNAL). The stored history must
-- be numbered 1..N and replay legally, and the event is numbered exactly one more; after the return (terminal in v1)
-- nothing further is recorded.
--   ESCALATE_FOR_REVIEW: the acting membership is the current A8.2 assignee and its roles grant exceptionTriage.record
--   and exceptionEscalation.raise; no escalation of the intake exists; the nominated member is a membership of the same
--   organization, not the escalator's, whose roles grant exceptionEscalation.handle and the six upstream reads (D2/D3).
--   ACKNOWLEDGE_ESCALATION: it names exactly the intake's escalation, which is not yet acknowledged; the acting
--   membership is the nominated member (not the escalator's user, not the current assignee), still eligible.
--   RECORD_FOLLOWUP: it names exactly the escalation's acknowledgement; the acting membership and user are the
--   nominated member who acknowledged it (not the current assignee), still eligible; the cited source is an event of
--   exactly this intake, organization and Claim in the owning A8.3 or A8.6 table, of the event code its kind names (D5,
--   D6).
--   RETURN_TO_OWNER: it names exactly the intake's escalation, acknowledged and with at least one follow-up; the acting
--   membership's roles grant exceptionEscalation.review; its membership and user differ from the escalator's, the
--   nominated member's and the acknowledger's, and it is not the current assignee (D3).
-- The service checks the same facts first; this guard holds them against any direct write. The A1, A8.2, A8.3, A8.6 and
-- A8.7 tables are read here and never written.
CREATE OR REPLACE FUNCTION exception_escalation_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  intake RECORD;
  latest_triage RECORD;
  prior RECORD;
  expected integer := 1;
  escalation_id uuid := NULL;
  escalator_membership uuid := NULL;
  escalator_user uuid := NULL;
  target_membership uuid := NULL;
  ack_id uuid := NULL;
  ack_membership uuid := NULL;
  ack_user uuid := NULL;
  followups integer := 0;
  returned boolean := false;
  resolution_requests integer := 0;
  resolution_decisions integer := 0;
  resolution_confirmed boolean := false;
  handler_codes text[] := ARRAY['exceptionEscalation.handle', 'exceptionIntake.read', 'exceptionTriage.read', 'exceptionInvestigation.read',
    'exceptionRemediation.read', 'exceptionRemediationWork.read', 'exceptionResolution.read'];
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_escalation_time: an escalation event is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."organization_id", i."claim_id" INTO intake
  FROM "exception_intake_records" i WHERE i."id" = NEW."exception_intake_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing intake
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM intake."organization_id" OR NEW."claim_id" IS DISTINCT FROM intake."claim_id" THEN
    RAISE EXCEPTION 'exception_escalation_coherence: the organization and Claim must be the parent intake''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."id" = NEW."recorded_by_membership_id" AND m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id"
  ) THEN
    RAISE EXCEPTION 'exception_escalation_member: an escalation event is recorded through the acting user''s own membership of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."event_code", t."assigned_member_id" INTO latest_triage
  FROM "exception_triage_events" t WHERE t."exception_intake_id" = NEW."exception_intake_id" ORDER BY t."sequence" DESC LIMIT 1;
  IF NOT FOUND OR latest_triage."event_code" NOT IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') THEN
    RAISE EXCEPTION 'exception_escalation_transition: the exception is not assigned; an escalation event is recorded only while it is'
      USING ERRCODE = 'check_violation';
  END IF;

  -- D1 — the A8.7 resolution state of the intake, read from its own table (one request, then at most one decision).
  SELECT count(*) FILTER (WHERE r."event_code" = 'REQUEST_INTERNAL_RESOLUTION'),
         count(*) FILTER (WHERE r."event_code" = 'DECIDE_INTERNAL_RESOLUTION'),
         coalesce(bool_or(r."event_code" = 'DECIDE_INTERNAL_RESOLUTION' AND r."decision_code" = 'CONFIRM_INTERNAL_RESOLUTION'), false)
    INTO resolution_requests, resolution_decisions, resolution_confirmed
  FROM "exception_resolution_events" r WHERE r."exception_intake_id" = NEW."exception_intake_id";
  IF resolution_confirmed THEN
    RAISE EXCEPTION 'exception_escalation_transition: the exception is RESOLVED_INTERNAL under A8.7; no escalation event is recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  IF resolution_requests > resolution_decisions THEN
    RAISE EXCEPTION 'exception_escalation_transition: an A8.7 resolution request awaits a decision; no escalation event is recorded while it is pending'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The stored history, replayed: numbered 1..N, the escalation, its acknowledgement, the follow-ups and the return.
  FOR prior IN
    SELECT e."id", e."sequence", e."event_code", e."target_member_id", e."recorded_by_membership_id", e."recorded_by_user_id"
    FROM "exception_escalation_events" e WHERE e."exception_intake_id" = NEW."exception_intake_id" ORDER BY e."sequence"
  LOOP
    IF prior."sequence" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'exception_escalation_sequence: the stored history of the intake is not numbered 1..N'
        USING ERRCODE = 'check_violation';
    END IF;
    IF prior."event_code" = 'ESCALATE_FOR_REVIEW' THEN
      escalation_id := prior."id"; escalator_membership := prior."recorded_by_membership_id"; escalator_user := prior."recorded_by_user_id";
      target_membership := prior."target_member_id";
    ELSIF prior."event_code" = 'ACKNOWLEDGE_ESCALATION' THEN
      ack_id := prior."id"; ack_membership := prior."recorded_by_membership_id"; ack_user := prior."recorded_by_user_id";
    ELSIF prior."event_code" = 'RECORD_FOLLOWUP' THEN
      followups := followups + 1;
    ELSE
      returned := true;
    END IF;
    expected := expected + 1;
  END LOOP;
  IF NEW."sequence" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'exception_escalation_sequence: the next event of this intake is number %', expected
      USING ERRCODE = 'check_violation';
  END IF;
  IF returned THEN
    RAISE EXCEPTION 'exception_escalation_transition: the escalation of this intake was returned to its owner (terminal in v1); no further event is recorded'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" = 'ESCALATE_FOR_REVIEW' THEN
    IF latest_triage."assigned_member_id" IS DISTINCT FROM NEW."recorded_by_membership_id" OR (
      SELECT count(DISTINCT p."code")
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" IN ('exceptionTriage.record', 'exceptionEscalation.raise')
    ) <> 2 THEN
      RAISE EXCEPTION 'exception_escalation_assignee: only the current A8.2 assignee holding exceptionTriage.record and exceptionEscalation.raise escalates the exception'
        USING ERRCODE = 'check_violation';
    END IF;
    IF escalation_id IS NOT NULL THEN
      RAISE EXCEPTION 'exception_escalation_transition: an escalation of this intake already exists; one escalation cycle per intake in v1'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."target_member_id" = NEW."recorded_by_membership_id" THEN
      RAISE EXCEPTION 'exception_escalation_independence: an escalation never nominates its own escalator'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "organization_memberships" t WHERE t."id" = NEW."target_member_id" AND t."organization_id" = NEW."organization_id"
    ) OR (
      SELECT count(DISTINCT p."code")
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."target_member_id" AND p."code" = ANY (handler_codes)
    ) <> cardinality(handler_codes) THEN
      RAISE EXCEPTION 'exception_escalation_target: the nominated member is a membership of the owning organization whose roles grant exceptionEscalation.handle and the six upstream reads'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF escalation_id IS NULL THEN
    RAISE EXCEPTION 'exception_escalation_transition: no escalation of this intake is open'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" IN ('ACKNOWLEDGE_ESCALATION', 'RECORD_FOLLOWUP') THEN
    IF NEW."recorded_by_membership_id" = escalator_membership OR NEW."recorded_by_user_id" = escalator_user THEN
      RAISE EXCEPTION 'exception_escalation_independence: an escalation is never acknowledged or followed up by its own escalator'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recorded_by_membership_id" IS DISTINCT FROM target_membership
      OR NEW."recorded_by_membership_id" = latest_triage."assigned_member_id"
      OR (
        SELECT count(DISTINCT p."code")
        FROM "membership_roles" mr
        JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id"
        WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" = ANY (handler_codes)
      ) <> cardinality(handler_codes) THEN
      RAISE EXCEPTION 'exception_escalation_target: only the nominated member, eligible now and not the current assignee, acknowledges and follows up the escalation'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."event_code" = 'ACKNOWLEDGE_ESCALATION' THEN
    IF ack_id IS NOT NULL OR NEW."escalation_event_id" IS DISTINCT FROM escalation_id THEN
      RAISE EXCEPTION 'exception_escalation_transition: an acknowledgement names exactly the intake''s escalation, which is acknowledged once'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW."event_code" = 'RECORD_FOLLOWUP' THEN
    IF ack_id IS NULL OR NEW."acknowledgement_event_id" IS DISTINCT FROM ack_id THEN
      RAISE EXCEPTION 'exception_escalation_transition: a follow-up names exactly the escalation''s acknowledgement and comes after it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recorded_by_user_id" IS DISTINCT FROM ack_user THEN
      RAISE EXCEPTION 'exception_escalation_target: only the nominated member who acknowledged the escalation records its follow-ups'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
      (NEW."source_event_kind" IN ('INVESTIGATION_EVIDENCE_LINK', 'INVESTIGATION_FINDING') AND EXISTS (
        SELECT 1 FROM "exception_investigation_events" s
        WHERE s."id" = NEW."source_event_id" AND s."exception_intake_id" = NEW."exception_intake_id"
          AND s."organization_id" = NEW."organization_id" AND s."claim_id" = NEW."claim_id"
          AND s."event_code" = CASE NEW."source_event_kind" WHEN 'INVESTIGATION_EVIDENCE_LINK' THEN 'LINK_EVIDENCE_REFERENCE' ELSE 'RECORD_FINDING' END))
      OR (NEW."source_event_kind" IN ('WORK_REPORT', 'WORK_VERIFICATION') AND EXISTS (
        SELECT 1 FROM "exception_remediation_work_events" s
        WHERE s."id" = NEW."source_event_id" AND s."exception_intake_id" = NEW."exception_intake_id"
          AND s."organization_id" = NEW."organization_id" AND s."claim_id" = NEW."claim_id"
          AND s."event_code" = CASE NEW."source_event_kind" WHEN 'WORK_REPORT' THEN 'RECORD_WORK_REPORT' ELSE 'VERIFY_WORK_REPORT' END))
    ) THEN
      RAISE EXCEPTION 'exception_escalation_source: a follow-up cites exactly an A8.3 or A8.6 event of this intake, organization and Claim, of the event code its kind names'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- RETURN_TO_OWNER
    IF NOT EXISTS (
      SELECT 1
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" = 'exceptionEscalation.review'
    ) THEN
      RAISE EXCEPTION 'exception_escalation_independence: the returning reviewer''s roles must grant exceptionEscalation.review'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recorded_by_membership_id" IN (escalator_membership, target_membership, ack_membership)
      OR NEW."recorded_by_user_id" IN (escalator_user, ack_user)
      OR NEW."recorded_by_membership_id" = latest_triage."assigned_member_id" THEN
      RAISE EXCEPTION 'exception_escalation_independence: an escalation is returned only by a member independent of its escalator, its nominated member and the current assignee'
        USING ERRCODE = 'check_violation';
    END IF;
    IF ack_id IS NULL OR followups = 0 OR NEW."escalation_event_id" IS DISTINCT FROM escalation_id THEN
      RAISE EXCEPTION 'exception_escalation_transition: a return names exactly the intake''s escalation, after its acknowledgement and at least one follow-up'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_escalation_events_insert_guard_trg
  BEFORE INSERT ON "exception_escalation_events"
  FOR EACH ROW EXECUTE FUNCTION exception_escalation_events_insert_guard();

-- §5 — escalation events are history: never updated (not even a no-op update), never deleted and never wiped in bulk
-- (a TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_escalation_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_escalation_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_escalation_events"
  FOR EACH ROW EXECUTE FUNCTION exception_escalation_append_only();

CREATE TRIGGER exception_escalation_events_no_truncate_trg
  BEFORE TRUNCATE ON "exception_escalation_events"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_escalation_append_only();

-- There is deliberately no status, current/latest, timer, due date, SLA, queue, priority, closure, reopen, execution,
-- correction, resolution, amount, currency, payer, narrative, attachment, payload, digest or export column, no queue or
-- job table, and no new column on any A1–A8.7 or CRG table.
