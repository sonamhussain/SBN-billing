-- A8.3 — Exception Investigation Evidence & Finding History
--
-- Creates exactly one append-only table: exception_investigation_events (A8-EXCEPTION-INVESTIGATION-1, the numbered
-- evidence-link and finding history of one A8.1 exception intake), with its indexes, RESTRICT foreign keys, a UNIQUE
-- number per intake and a UNIQUE link per (intake, kind, record), CHECKs for the contract, the sequence, the two
-- controlled events and each event's exact shape, an insert guard that holds database time, the parent intake's
-- organization and Claim, the acting membership, the current A8.2 assignment and its eligibility, a contiguous
-- sequence, the evidence reference and the finding's earlier link, and append-only and TRUNCATE triggers. No applied
-- migration is modified, no existing table is altered, and the generated statements below were produced
-- schema-to-schema with no unrelated drift.
--
-- An event records which immutable owner record was checked and which controlled finding it supported. It is never an
-- assignment, resolution, closure, escalation, payer outcome, payment or export, and it stores no PHI, payload, source
-- bytes, digest, amount or free text.

-- CreateTable
CREATE TABLE "exception_investigation_events" (
    "id" UUID NOT NULL,
    "exception_intake_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "contract_version" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "evidence_kind" TEXT,
    "evidence_record_id" UUID,
    "evidence_contract_version" TEXT,
    "evidence_basis_code" TEXT,
    "linked_evidence_event_id" UUID,
    "finding_code" TEXT,
    "recorded_by_membership_id" UUID NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exception_investigation_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exception_investigation_events_organization_id_idx" ON "exception_investigation_events"("organization_id");

-- CreateIndex
CREATE INDEX "exception_investigation_events_claim_id_idx" ON "exception_investigation_events"("claim_id");

-- CreateIndex
CREATE INDEX "exception_investigation_events_linked_evidence_event_id_idx" ON "exception_investigation_events"("linked_evidence_event_id");

-- CreateIndex
CREATE INDEX "exception_investigation_events_recorded_by_membership_id_idx" ON "exception_investigation_events"("recorded_by_membership_id");

-- CreateIndex
CREATE INDEX "exception_investigation_events_recorded_by_user_id_idx" ON "exception_investigation_events"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "exception_investigation_events_sequence_key" ON "exception_investigation_events"("exception_intake_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "exception_investigation_events_link_key" ON "exception_investigation_events"("exception_intake_id", "evidence_kind", "evidence_record_id");

-- AddForeignKey
ALTER TABLE "exception_investigation_events" ADD CONSTRAINT "exception_investigation_events_exception_intake_id_fkey" FOREIGN KEY ("exception_intake_id") REFERENCES "exception_intake_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_investigation_events" ADD CONSTRAINT "exception_investigation_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_investigation_events" ADD CONSTRAINT "exception_investigation_events_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_investigation_events" ADD CONSTRAINT "exception_investigation_events_linked_evidence_event_id_fkey" FOREIGN KEY ("linked_evidence_event_id") REFERENCES "exception_investigation_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_investigation_events" ADD CONSTRAINT "exception_investigation_events_recorded_by_membership_id_fkey" FOREIGN KEY ("recorded_by_membership_id") REFERENCES "organization_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exception_investigation_events" ADD CONSTRAINT "exception_investigation_events_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A8.3 §5, §6) --------------------------------------------------------------

-- §5 — the fixed contract, a positive sequence, the two controlled events and the exact shape of each: a link carries
-- a controlled kind, one record, exactly that kind's owner contract and — for the intake basis only — a controlled
-- basis code, and nothing else; a finding carries exactly one linked event and a controlled finding code. Each NOT
-- NULL explicitly (a NULL must never pass an IN list).
ALTER TABLE "exception_investigation_events"
  ADD CONSTRAINT "exception_investigation_events_contract_chk" CHECK ("contract_version" IS NOT NULL AND "contract_version" = 'A8-EXCEPTION-INVESTIGATION-1');

ALTER TABLE "exception_investigation_events"
  ADD CONSTRAINT "exception_investigation_events_sequence_chk" CHECK ("sequence" IS NOT NULL AND "sequence" >= 1);

ALTER TABLE "exception_investigation_events"
  ADD CONSTRAINT "exception_investigation_events_event_code_chk" CHECK (
    "event_code" IS NOT NULL AND "event_code" IN ('LINK_EVIDENCE_REFERENCE', 'RECORD_FINDING')
  );

ALTER TABLE "exception_investigation_events"
  ADD CONSTRAINT "exception_investigation_events_shape_chk" CHECK (
    ("event_code" = 'LINK_EVIDENCE_REFERENCE'
      AND "evidence_record_id" IS NOT NULL AND "linked_evidence_event_id" IS NULL AND "finding_code" IS NULL
      AND (("evidence_kind" = 'INTAKE_BASIS' AND "evidence_contract_version" = 'A8-EXCEPTION-INTAKE-1'
             AND "evidence_basis_code" IS NOT NULL
             AND "evidence_basis_code" IN ('UNLINKED_FROZEN_SUBMISSION', 'ASSESSMENT_CASE_ORGANIZATION_MISMATCH', 'ASSESSMENT_CASE_DIGEST_MISMATCH', 'ASSESSMENT_REVIEW_REQUIRED'))
        OR ("evidence_kind" = 'TRIAGE_EVENT' AND "evidence_contract_version" = 'A8-EXCEPTION-TRIAGE-1' AND "evidence_basis_code" IS NULL)
        OR ("evidence_kind" = 'A7_CASE_ASSESSMENT' AND "evidence_contract_version" = 'A7-CLOSURE-PREREQ-1' AND "evidence_basis_code" IS NULL)))
    OR ("event_code" = 'RECORD_FINDING'
      AND "linked_evidence_event_id" IS NOT NULL
      AND "finding_code" IS NOT NULL AND "finding_code" IN ('EVIDENCE_CONFIRMS_RECORDED_CONFLICT', 'EVIDENCE_INCONCLUSIVE', 'FURTHER_REVIEW_REQUIRED')
      AND "evidence_kind" IS NULL AND "evidence_record_id" IS NULL AND "evidence_contract_version" IS NULL AND "evidence_basis_code" IS NULL)
  );

-- §6 — an event is recorded and created at the database's own transaction time; belongs to exactly the organization
-- and Claim of its parent intake; is recorded through the acting user's own membership of that organization; and only
-- while the intake's latest A8.2 triage event assigns the exception to exactly that membership, whose roles grant both
-- exceptionTriage.record (the A8.2 assignee policy) and exceptionInvestigation.record at this moment. It is numbered
-- exactly one more than the intake's stored investigation history, which must itself be numbered 1..N. A link names
-- an existing record of its kind for exactly this intake, Claim and organization, under the stated contract (the
-- intake's own basis record and basis code; an A8.2 event of this intake; an A7.5 assessment of a case of this Claim);
-- the same record is linked once per kind (UNIQUE). A finding names an earlier link of this intake and does not
-- repeat the latest finding unchanged. The service checks the same facts first; this guard holds them against any
-- direct write. The A8.2 table is read here and never written.
CREATE OR REPLACE FUNCTION exception_investigation_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  intake RECORD;
  latest_triage RECORD;
  prior RECORD;
  expected integer := 1;
  latest_finding_code text;
  latest_finding_link uuid;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'exception_investigation_time: an investigation event is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT i."organization_id", i."claim_id", i."contract_version", i."basis_code", i."basis_record_id" INTO intake
  FROM "exception_intake_records" i WHERE i."id" = NEW."exception_intake_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing intake
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM intake."organization_id" OR NEW."claim_id" IS DISTINCT FROM intake."claim_id" THEN
    RAISE EXCEPTION 'exception_investigation_coherence: the organization and Claim must be the parent intake''s'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "organization_memberships" m
    WHERE m."id" = NEW."recorded_by_membership_id" AND m."organization_id" = NEW."organization_id" AND m."user_id" = NEW."recorded_by_user_id"
  ) THEN
    RAISE EXCEPTION 'exception_investigation_member: an investigation event is recorded through the acting user''s own membership of the owning organization'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT t."event_code", t."assigned_member_id" INTO latest_triage
  FROM "exception_triage_events" t WHERE t."exception_intake_id" = NEW."exception_intake_id" ORDER BY t."sequence" DESC LIMIT 1;
  IF NOT FOUND OR latest_triage."event_code" NOT IN ('ASSIGN_OWNER', 'REASSIGN_OWNER') OR latest_triage."assigned_member_id" IS DISTINCT FROM NEW."recorded_by_membership_id" THEN
    RAISE EXCEPTION 'exception_investigation_assignee: only the current A8.2 assignee of the exception records investigation events'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (
    SELECT count(DISTINCT p."code")
    FROM "membership_roles" mr
    JOIN "role_permissions" rp ON rp."role_id" = mr."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
    WHERE mr."membership_id" = NEW."recorded_by_membership_id" AND p."code" IN ('exceptionTriage.record', 'exceptionInvestigation.record')
  ) <> 2 THEN
    RAISE EXCEPTION 'exception_investigation_assignee: the assignee''s roles must grant exceptionTriage.record and exceptionInvestigation.record'
      USING ERRCODE = 'check_violation';
  END IF;

  FOR prior IN
    SELECT e."sequence", e."event_code", e."linked_evidence_event_id", e."finding_code"
    FROM "exception_investigation_events" e WHERE e."exception_intake_id" = NEW."exception_intake_id" ORDER BY e."sequence"
  LOOP
    IF prior."sequence" IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'exception_investigation_sequence: the stored history of the intake is not numbered 1..N'
        USING ERRCODE = 'check_violation';
    END IF;
    IF prior."event_code" = 'RECORD_FINDING' THEN
      latest_finding_code := prior."finding_code"; latest_finding_link := prior."linked_evidence_event_id";
    END IF;
    expected := expected + 1;
  END LOOP;
  IF NEW."sequence" IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'exception_investigation_sequence: the next event of this intake is number %', expected
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" = 'LINK_EVIDENCE_REFERENCE' AND NOT (
    (NEW."evidence_kind" = 'INTAKE_BASIS'
      AND NEW."evidence_record_id" = intake."basis_record_id" AND NEW."evidence_basis_code" = intake."basis_code" AND NEW."evidence_contract_version" = intake."contract_version")
    OR (NEW."evidence_kind" = 'TRIAGE_EVENT' AND EXISTS (
      SELECT 1 FROM "exception_triage_events" t
      WHERE t."id" = NEW."evidence_record_id" AND t."exception_intake_id" = NEW."exception_intake_id" AND t."organization_id" = NEW."organization_id"
        AND t."claim_id" = NEW."claim_id" AND t."contract_version" = NEW."evidence_contract_version"))
    OR (NEW."evidence_kind" = 'A7_CASE_ASSESSMENT' AND EXISTS (
      SELECT 1 FROM "evidence_prereq_results" a
      JOIN "evidence_case_snapshots" h ON h."id" = a."evidence_case_id"
      JOIN "claim_freezes" f ON f."id" = h."claim_submission_id"
      WHERE a."id" = NEW."evidence_record_id" AND a."organization_id" = NEW."organization_id" AND h."organization_id" = NEW."organization_id"
        AND f."claim_id" = NEW."claim_id" AND a."contract_version" = NEW."evidence_contract_version"))
  ) THEN
    RAISE EXCEPTION 'exception_investigation_evidence: a link names an existing % record of this intake, Claim and organization under its contract', NEW."evidence_kind"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."event_code" = 'RECORD_FINDING' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "exception_investigation_events" l
      WHERE l."id" = NEW."linked_evidence_event_id" AND l."exception_intake_id" = NEW."exception_intake_id"
        AND l."event_code" = 'LINK_EVIDENCE_REFERENCE' AND l."sequence" < NEW."sequence"
    ) THEN
      RAISE EXCEPTION 'exception_investigation_finding: a finding names an earlier evidence link of this intake'
        USING ERRCODE = 'check_violation';
    END IF;
    IF latest_finding_code IS NOT DISTINCT FROM NEW."finding_code" AND latest_finding_link IS NOT DISTINCT FROM NEW."linked_evidence_event_id" THEN
      RAISE EXCEPTION 'exception_investigation_repeat: the finding repeats the latest finding unchanged'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_investigation_events_insert_guard_trg
  BEFORE INSERT ON "exception_investigation_events"
  FOR EACH ROW EXECUTE FUNCTION exception_investigation_events_insert_guard();

-- §6 — investigation events are history: never updated (not even a no-op update), never deleted and never wiped in
-- bulk (a TRUNCATE ... CASCADE included).
CREATE OR REPLACE FUNCTION exception_investigation_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER exception_investigation_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "exception_investigation_events"
  FOR EACH ROW EXECUTE FUNCTION exception_investigation_append_only();

CREATE TRIGGER exception_investigation_events_no_truncate_trg
  BEFORE TRUNCATE ON "exception_investigation_events"
  FOR EACH STATEMENT EXECUTE FUNCTION exception_investigation_append_only();

-- There is deliberately no status, current/latest, resolution, remediation, SLA, escalation, amount, currency, payer,
-- narrative, attachment, payload, digest or export column, no queue or job table, and no new column on any A1–A8.2
-- table.
