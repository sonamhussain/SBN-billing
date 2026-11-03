-- A8.2 — Exception Triage & Assignment Event History
--
-- Creates exactly one append-only table: exception_triage_events (A8-EXCEPTION-TRIAGE-1, the numbered triage and
-- assignment history of one A8.1 exception intake), with its indexes, RESTRICT foreign keys, CHECKs for the contract,
-- the sequence, the four controlled events and each event's exact shape, an insert guard that holds database time,
-- the parent intake's organization and Claim, the acting member, a contiguous sequence, a legal transition and an
-- eligible assignee, and append-only and TRUNCATE triggers. No applied migration is modified, no existing table is
-- altered, and the generated statements below were produced schema-to-schema with no unrelated drift.
--
-- An event records an internal triage or assignment decision. It is never an investigation, resolution, closure,
-- SLA, escalation, payer outcome, payment or export, and it stores no PHI, payload, amount or free text.

-- CreateTable
CREATE TABLE "exception_triage_events" (
    "id" UUID NOT NULL,
    "exception_intake_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "category_code" TEXT,
    "priority_code" TEXT,
    "assigned_member_id" UUID,
    "reason_code" TEXT,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_triage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_triage_events_organization_id_idx" ON "exception_triage_events"("organization_id");

-- CreateIndex
CREATE INDEX "exception_triage_events_claim_id_idx" ON "exception_triage_events"("claim_id");

-- CreateIndex
CREATE INDEX "exception_triage_events_assigned_member_id_idx" ON "exception_triage_events"("assigned_member_id");

-- CreateIndex
CREATE INDEX "exception_triage_events_recorded_by_user_id_idx" ON "exception_triage_events"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_triage_events_sequence_key" ON "exception_triage_events"("exception_intake_id", "sequence");

-- AddForeignKey
ALTER TABLE "exception_triage_events" ADD CONSTRAINT "exception_triage_events_exception_intake_id_fkey" FOREIGN KEY ("exception_intake_id") REFERENCES "exception_intake_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_triage_events" ADD CONSTRAINT "exception_triage_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_triage_events" ADD CONSTRAINT "exception_triage_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_triage_events" ADD CONSTRAINT "exception_triage_events_assigned_member_id_fkey" FOREIGN KEY ("assigned_member_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_triage_events" ADD CONSTRAINT "exception_triage_events_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A8.2 §4, §6) --------------------------------------------------------------

-- §4 — the fixed contract, a positive sequence, the four controlled events and the exact shape of each: a
-- classification carries a controlled category and priority and nothing else; an assignment or reassignment exactly
-- one member; a return exactly a controlled reason. Each NOT NULL explicitly (a NULL must never pass an IN list).
ALTER TABLE "exception_triage_events"
  ADD CONSTRAINT "exception_triage_events_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-EXCEPTION-TRIAGE-1');

ALTER TABLE "exception_triage_events"
  ADD CONSTRAINT "exception_triage_events_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1);

ALTER TABLE "exception_triage_events"
  ADD CONSTRAINT "exception_triage_events_event_code_chk" CHECK (
    "event_code" IS NOT NULL AND "event_code" IN ('TRIAGE_CLASSIFY', 'ASSIGN_OWNER', 'REASSIGN_OWNER', 'RETURN_TO_TRIAGE')
  );

ALTER TABLE "exception_triage_events"
  ADD CONSTRAINT "exception_triage_events_shape_chk" CHECK (
    ("event_code" = 'TRIAGE_CLASSIFY'
      AND "category_code" IS NOT NULL AND "category_code" IN ('PROVENANCE_INTEGRITY', 'SOURCE_REFERENCE', 'CONTRACT_COMPATIBILITY', 'HISTORICAL_COHERENCE', 'HUMAN_REVIEW')
      AND "priority_code" IS NOT NULL AND "priority_code" IN ('ROUTINE', 'ELEVATED', 'URGENT')
      AND "assigned_member_id" IS NULL AND "reason_code" IS NULL)
    OR ("event_code" IN ('ASSIGN_OWNER', 'REASSIGN_OWNER')
      AND "assigned_member_id" IS NOT NULL AND "category_code" IS NULL AND "priority_code" IS NULL AND "reason_code" IS NULL)
    OR ("event_code" = 'RETURN_TO_TRIAGE'
      AND "reason_code" IS NOT NULL AND "reason_code" IN ('ASSIGNEE_UNAVAILABLE', 'ASSIGNMENT_INCORRECT', 'CLASSIFICATION_REVIEW_NEEDED')
      AND "category_code" IS NULL AND "priority_code" IS NULL AND "assigned_member_id" IS NULL)
  );

-- §6 — an event is recorded and created at the database's own transaction time; belongs to exactly the organization
-- and Claim of its parent intake; is recorded by a current member of that organization; is numbered exactly one more
-- than the intake's stored history, which must itself be numbered 1..N; is a legal transition from the disposition
-- that history derives (a reclassification must change the category or priority; a reassignment must name another
-- member); and an assignment names a membership of the same organization whose roles grant exceptionTriage.record at
-- this moment. The service checks the same facts first; this guard holds them against any direct write.
CREATE OR REPLACE FUNCTION exception_triage_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  intake RECORD;
  prior RECORD;
  expected integer := 1;
  disposition text := 'UNTRIAGED';
  current_category text;
  current_priority text;
  current_assignee uuid;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_triage_time: a triage event is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."organization_id", i."claim_id" INTO intake FROM "exception_intake_records" i WHERE i."id" = NEW."exception_intake_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing intake
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM intake."organization_id" OR NEW."claim_id" IS DISTINCT FROM intake."claim_id" THEN
    RAISE EXCEPTION 'exception_triage_coherence: the organization and Claim must be the parent intake''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "organization_memberships" m WHERE m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id") THEN
    RAISE EXCEPTION 'exception_triage_member: a triage event is recorded by a member of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR prior IN
    SELECT e."sequence", e."event_code", e."category_code", e."priority_code", e."assigned_member_id"
    FROM "exception_triage_events" e WHERE e."exception_intake_id" = NEW."exception_intake_id" ORDER BY e."sequence"
  LOOP
    IF prior."sequence" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'exception_triage_sequence: the stored history of the intake is not numbered 1..N'
        USING ERRCODE = 'check_violation';
    END IF;
    IF prior."event_code" = 'TRIAGE_CLASSIFY' THEN
      disposition := 'TRIAGED'; current_category := prior."category_code"; current_priority := prior."priority_code"; current_assignee := NULL;
    ELSIF prior."event_code" IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') THEN
      disposition := 'ASSIGNED'; current_assignee := prior."assigned_member_id";
    ELSIF prior."event_code" = 'RETURN_TO_TRIAGE' THEN
      disposition := 'TRIAGED'; current_assignee := NULL;
    END IF;
    expected := expected + 1;
  END LOOP;
  IF NEW."sequence" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'exception_triage_sequence: the next event of this intake is number %', expected
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    (NEW."event_code" = 'TRIAGE_CLASSIFY' AND (disposition = 'UNTRIAGED'
      OR (disposition = 'TRIAGED' AND (NEW."category_code" IS DISTINCT FROM current_category OR NEW."priority_code" IS DISTINCT FROM current_priority))))
    OR (NEW."event_code" = 'ASSIGN_OWNER' AND disposition = 'TRIAGED')
    OR (NEW."event_code" = 'REASSIGN_OWNER' AND disposition = 'ASSIGNED' AND NEW."assigned_member_id" IS DISTINCT FROM current_assignee)
    OR (NEW."event_code" = 'RETURN_TO_TRIAGE' AND disposition = 'ASSIGNED')
  ) THEN
    RAISE EXCEPTION 'exception_triage_transition: % is not a legal transition from %', NEW."event_code", disposition
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') AND NOT EXISTS (
    SELECT 1
    FROM "organization_memberships" m
    JOIN "membership_roles" mr ON mr."membership_id" = m."id"
    JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
    WHERE m."id" = NEW."assigned_member_id" AND m."organization_id" = NEW."organization_id" AND p."code" = 'exceptionTriage.record'
  ) THEN
    RAISE EXCEPTION 'exception_triage_assignee: the assignee must be a member of the owning organization whose role grants exceptionTriage.record'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_triage_events_insert_guard_trg
  BEFORE INSERT ON "exception_triage_events"
  FOR EACH ROW EXECUTE FUNCTION exception_triage_events_insert_guard();

-- §6 — triage events are history: never updated (not even a no-op update), never deleted and never wiped in bulk (a
-- TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_triage_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_triage_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_triage_events"
  FOR EACH ROW EXECUTE FUNCTION exception_triage_append_only();

CREATE TRIGGER exception_triage_events_no_truncate_trg
  BEFORE TRUNCATE ON "exception_triage_events"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_triage_append_only();

-- There is deliberately no status, current/latest, SLA, escalation, investigation, resolution, amount, currency,
-- payer, narrative, attachment, payload or export column, no queue or job table, and no new column on any A1–A8.1
-- table.
