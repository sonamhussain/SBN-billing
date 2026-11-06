-- A8.5 — Exception Remediation Proposal & Review Decision
--
-- Creates exactly one append-only table: exception_remediation_events (A8-REMEDIATION-PLAN-1, the numbered
-- proposal-and-review history of one A8.1 exception intake), with its indexes, RESTRICT foreign keys, a UNIQUE number
-- per intake and a UNIQUE review per proposal, CHECKs for the contract, the sequence, the two controlled events and
-- each event's exact shape, an insert guard that holds database time, the parent intake's organization and Claim, the
-- acting membership, the current A8.2 assignment and the proposer's or reviewer's permission, the A8.3 finding, the
-- outstanding proposal, the reviewer's independence and a contiguous sequence, and append-only and TRUNCATE triggers.
-- No applied migration is modified, no existing table is altered, and the generated statements below were produced
-- schema-to-schema with no unrelated drift.
--
-- An event records a proposed next action and an independent decision about it. An approval is internal planning
-- authorization only: never an execution, correction, resolution, closure, escalation, payer outcome or payment. No
-- PHI, payload, source bytes, digest, amount or free text is stored.

-- CreateTable
CREATE TABLE "exception_remediation_events" (
    "id" UUID NOT NULL,
    "exception_intake_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "action_code" TEXT,
    "a8_3_finding_event_id" UUID,
    "rationale_code" TEXT,
    "proposal_event_id" UUID,
    "decision_code" TEXT,
    "review_reason_code" TEXT,
    "recorded_by_membership_id" UUID NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_remediation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_remediation_events_organization_id_idx" ON "exception_remediation_events"("organization_id");

-- CreateIndex
CREATE INDEX "exception_remediation_events_claim_id_idx" ON "exception_remediation_events"("claim_id");

-- CreateIndex
CREATE INDEX "exception_remediation_events_a8_3_finding_event_id_idx" ON "exception_remediation_events"("a8_3_finding_event_id");

-- CreateIndex
CREATE INDEX "exception_remediation_events_recorded_by_membership_id_idx" ON "exception_remediation_events"("recorded_by_membership_id");

-- CreateIndex
CREATE INDEX "exception_remediation_events_recorded_by_user_id_idx" ON "exception_remediation_events"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_remediation_events_sequence_key" ON "exception_remediation_events"("exception_intake_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "exception_remediation_events_proposal_event_id_key" ON "exception_remediation_events"("proposal_event_id");

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_exception_intake_id_fkey" FOREIGN KEY ("exception_intake_id") REFERENCES "exception_intake_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_a8_3_finding_event_id_fkey" FOREIGN KEY ("a8_3_finding_event_id") REFERENCES "exception_investigation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_proposal_event_id_fkey" FOREIGN KEY ("proposal_event_id") REFERENCES "exception_remediation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_recorded_by_membership_id_fkey" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_remediation_events" ADD CONSTRAINT "exception_remediation_events_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A8.5 §4, §5) ---------------------------------------------------------------

-- §3/§5 — the fixed contract, a positive sequence, the two controlled events and the exact shape of each: a proposal
-- carries a controlled action, one A8.3 finding event and a controlled rationale, and nothing else; a review carries
-- one proposal event and a controlled decision, with a controlled reason exactly when it returns the proposal, and
-- nothing else. Each NOT NULL explicitly (a NULL must never pass an IN list).
ALTER TABLE "exception_remediation_events"
  ADD CONSTRAINT "exception_remediation_events_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-REMEDIATION-PLAN-1');

ALTER TABLE "exception_remediation_events"
  ADD CONSTRAINT "exception_remediation_events_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1);

ALTER TABLE "exception_remediation_events"
  ADD CONSTRAINT "exception_remediation_events_event_code_chk" CHECK (
    "event_code" IS NOT NULL AND "event_code" IN ('PROPOSE_ACTION', 'REVIEW_ACTION')
  );

ALTER TABLE "exception_remediation_events"
  ADD CONSTRAINT "exception_remediation_events_shape_chk" CHECK (
    ("event_code" = 'PROPOSE_ACTION'
      AND "action_code" IS NOT NULL
      AND "action_code" IN ('REVIEW_SOURCE_PROVENANCE', 'REQUEST_INTERNAL_DOCUMENTATION_CHECK', 'RECHECK_CODING_REFERENCE', 'REFER_FOR_POLICY_REVIEW')
      AND "a8_3_finding_event_id" IS NOT NULL
      AND "rationale_code" IS NOT NULL AND "rationale_code" IN ('RECORDED_CONFLICT', 'INSUFFICIENT_EVIDENCE', 'POLICY_CLARIFICATION_NEEDED')
      AND "proposal_event_id" IS NULL AND "decision_code" IS NULL AND "review_reason_code" IS NULL)
    OR ("event_code" = 'REVIEW_ACTION'
      AND "proposal_event_id" IS NOT NULL
      AND "action_code" IS NULL AND "a8_3_finding_event_id" IS NULL AND "rationale_code" IS NULL
      AND (("decision_code" = 'APPROVE_PROPOSAL' AND "review_reason_code" IS NULL)
        OR ("decision_code" = 'RETURN_PROPOSAL' AND "review_reason_code" IS NOT NULL
            AND "review_reason_code" IN ('INSUFFICIENT_SUPPORT', 'WRONG_SCOPE', 'NEEDS_MORE_INVESTIGATION'))))
  );

-- §4/§5 — an event is recorded and created at the database's own transaction time; belongs to exactly the organization
-- and Claim of its parent intake; is recorded through the acting user's own membership of that organization; and only
-- while the intake's latest A8.2 triage event assigns the exception. Its stored remediation history must be numbered
-- 1..N and replay legally, and it is numbered exactly one more.
--   A proposal: the exception is assigned to exactly the acting membership, whose roles grant exceptionTriage.record
--   (the A8.2 assignee policy) and exceptionRemediation.propose at this moment; it names a RECORD_FINDING of exactly
--   this intake; no proposal awaits review, nothing was approved, and it does not repeat the returned proposal
--   unchanged.
--   A review: the acting membership's roles grant exceptionRemediation.review at this moment; it names exactly the
--   proposal that awaits review; the reviewer's membership and user both differ from the proposal's.
-- The service checks the same facts first; this guard holds them against any direct write. The A8.2 and A8.3 tables are
-- read here and never written.
CREATE OR REPLACE FUNCTION exception_remediation_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  intake RECORD;
  latest_triage RECORD;
  prior RECORD;
  expected integer := 1;
  pending_id uuid := NULL;
  pending_membership uuid := NULL;
  pending_user uuid := NULL;
  has_returned boolean := false;
  returned_action text := NULL;
  returned_finding uuid := NULL;
  returned_rationale text := NULL;
  approved boolean := false;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_remediation_time: a remediation event is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."organization_id", i."claim_id" INTO intake
  FROM "exception_intake_records" i WHERE i."id" = NEW."exception_intake_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing intake
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM intake."organization_id" OR NEW."claim_id" IS DISTINCT FROM intake."claim_id" THEN
    RAISE EXCEPTION 'exception_remediation_coherence: the organization and Claim must be the parent intake''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."id" = NEW."recorded_by_membership_id" AND m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id"
  ) THEN
    RAISE EXCEPTION 'exception_remediation_member: a remediation event is recorded through the acting user''s own membership of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT t."event_code", t."assigned_member_id" INTO latest_triage
  FROM "exception_triage_events" t WHERE t."exception_intake_id" = NEW."exception_intake_id" ORDER BY t."sequence" DESC LIMIT 1;
  IF NOT FOUND OR latest_triage."event_code" NOT IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') THEN
    RAISE EXCEPTION 'exception_remediation_transition: the exception is not assigned; a proposal is proposed and reviewed only while it is'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The stored history, replayed: numbered 1..N, the outstanding proposal, the returned one and any approval.
  FOR prior IN
    SELECT e."id", e."sequence", e."event_code", e."action_code", e."a8_3_finding_event_id", e."rationale_code", e."proposal_event_id", e."decision_code",
           e."recorded_by_membership_id", e."recorded_by_user_id"
    FROM "exception_remediation_events" e WHERE e."exception_intake_id" = NEW."exception_intake_id" ORDER BY e."sequence"
  LOOP
    IF prior."sequence" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'exception_remediation_sequence: the stored history of the intake is not numbered 1..N'
        USING ERRCODE = 'check_violation';
    END IF;
    IF prior."event_code" = 'PROPOSE_ACTION' THEN
      pending_id := prior."id"; pending_membership := prior."recorded_by_membership_id"; pending_user := prior."recorded_by_user_id";
      has_returned := false;
    ELSIF prior."decision_code" = 'APPROVE_PROPOSAL' THEN
      approved := true; pending_id := NULL;
    ELSE
      SELECT p."action_code", p."a8_3_finding_event_id", p."rationale_code" INTO returned_action, returned_finding, returned_rationale
      FROM "exception_remediation_events" p WHERE p."id" = prior."proposal_event_id";
      has_returned := true; pending_id := NULL;
    END IF;
    expected := expected + 1;
  END LOOP;
  IF NEW."sequence" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'exception_remediation_sequence: the next event of this intake is number %', expected
      USING ERRCODE = 'check_violation';
  END IF;
  IF approved THEN
    RAISE EXCEPTION 'exception_remediation_transition: the proposal of this intake was approved for planning; no further event is recorded'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" = 'PROPOSE_ACTION' THEN
    IF latest_triage."assigned_member_id" IS DISTINCT FROM NEW."recorded_by_membership_id" OR (
      SELECT count(DISTINCT p."code")
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" IN ('exceptionTriage.record', 'exceptionRemediation.propose')
    ) <> 2 THEN
      RAISE EXCEPTION 'exception_remediation_assignee: only the current A8.2 assignee holding exceptionTriage.record and exceptionRemediation.propose proposes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "exception_investigation_events" f
      WHERE f."id" = NEW."a8_3_finding_event_id" AND f."exception_intake_id" = NEW."exception_intake_id"
        AND f."organization_id" = NEW."organization_id" AND f."claim_id" = NEW."claim_id" AND f."event_code" = 'RECORD_FINDING'
    ) THEN
      RAISE EXCEPTION 'exception_remediation_finding: a proposal names an A8.3 RECORD_FINDING event of this intake'
        USING ERRCODE = 'check_violation';
    END IF;
    IF pending_id IS NOT NULL THEN
      RAISE EXCEPTION 'exception_remediation_transition: a proposal already awaits review'
        USING ERRCODE = 'check_violation';
    END IF;
    IF has_returned AND returned_action IS NOT DISTINCT FROM NEW."action_code"
       AND returned_finding IS NOT DISTINCT FROM NEW."a8_3_finding_event_id" AND returned_rationale IS NOT DISTINCT FROM NEW."rationale_code" THEN
      RAISE EXCEPTION 'exception_remediation_repeat: the proposal repeats the returned proposal unchanged'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1
      FROM "membership_roles" mr
      JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
      JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" = 'exceptionRemediation.review'
    ) THEN
      RAISE EXCEPTION 'exception_remediation_reviewer: the reviewer''s roles must grant exceptionRemediation.review'
        USING ERRCODE = 'check_violation';
    END IF;
    IF pending_id IS NULL OR NEW."proposal_event_id" IS DISTINCT FROM pending_id THEN
      RAISE EXCEPTION 'exception_remediation_transition: a review names exactly the proposal that awaits review'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recorded_by_membership_id" = pending_membership OR NEW."recorded_by_user_id" = pending_user THEN
      RAISE EXCEPTION 'exception_remediation_reviewer: a proposal is never reviewed by its own author'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_remediation_events_insert_guard_trg
  BEFORE INSERT ON "exception_remediation_events"
  FOR EACH ROW EXECUTE FUNCTION exception_remediation_events_insert_guard();

-- §5 — remediation events are history: never updated (not even a no-op update), never deleted and never wiped in bulk
-- (a TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_remediation_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_remediation_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_remediation_events"
  FOR EACH ROW EXECUTE FUNCTION exception_remediation_append_only();

CREATE TRIGGER exception_remediation_events_no_truncate_trg
  BEFORE TRUNCATE ON "exception_remediation_events"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_remediation_append_only();

-- There is deliberately no status, current/latest, execution, correction, resolution, closure, SLA, escalation,
-- amount, currency, payer, narrative, attachment, payload, digest or export column, no queue or job table, and no new
-- column on any A1–A8.3 table.
