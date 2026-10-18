-- A6.8 — Claim Lifecycle State & Transition Governance
--
-- Creates exactly one append-only table: claim_freeze_lifecycle_events (A6-LIFECYCLE-1), the internal
-- lifecycle events of an A6.7 frozen submission, with its indexes, CHECKs, transition guard and append-only
-- trigger. No applied migration is modified, no existing table is altered (claim_freezes keeps every
-- column, byte and digest), and the generated statements below were produced schema-to-schema with no
-- unrelated drift. The table is named after the claim_freezes table it belongs to; the column, routes,
-- permissions, audit and contract keep the business vocabulary.
--
-- The current disposition is derived from these events and never stored: there is no state column, no
-- current or latest pointer, and an untouched freeze is FROZEN without any row. Every state is internal:
-- nothing here is a send, a delivery, a payer response or a payment.

-- CreateTable
CREATE TABLE "claim_freeze_lifecycle_events" (
    "id" UUID NOT NULL,
    "claim_submission_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "event_code" TEXT NOT NULL,
    "reason_code" TEXT,
    "actor_user_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifecycle_contract_version" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_freeze_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claim_freeze_lifecycle_events_actor_user_id_idx" ON "claim_freeze_lifecycle_events"("actor_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_freeze_lifecycle_events_claim_submission_id_sequence_key" ON "claim_freeze_lifecycle_events"("claim_submission_id", "sequence");

-- AddForeignKey
ALTER TABLE "claim_freeze_lifecycle_events" ADD CONSTRAINT "claim_freeze_lifecycle_events_claim_submission_id_fkey" FOREIGN KEY ("claim_submission_id") REFERENCES "claim_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freeze_lifecycle_events" ADD CONSTRAINT "claim_freeze_lifecycle_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A6.8 §3, §4) -------------------------------------------------------------

-- §3 — an event carries its fixed contract, one of the four A6-LIFECYCLE-1 event codes and a positive
-- submission-local sequence.
ALTER TABLE "claim_freeze_lifecycle_events"
  ADD CONSTRAINT "claim_freeze_lifecycle_events_contract_version_chk" CHECK ("lifecycle_contract_version" = 'A6-LIFECYCLE-1');

ALTER TABLE "claim_freeze_lifecycle_events"
  ADD CONSTRAINT "claim_freeze_lifecycle_events_event_code_chk" CHECK ("event_code" IN ('PLACE_HOLD', 'RELEASE_HOLD', 'AUTHORIZE_RELEASE', 'WITHDRAW_INTERNAL'));

ALTER TABLE "claim_freeze_lifecycle_events"
  ADD CONSTRAINT "claim_freeze_lifecycle_events_sequence_chk" CHECK ("sequence" >= 1);

-- §3 — the event/reason shape: AUTHORIZE_RELEASE carries no reason; every other event carries exactly one
-- of the five controlled reason codes (never free text).
ALTER TABLE "claim_freeze_lifecycle_events"
  ADD CONSTRAINT "claim_freeze_lifecycle_events_reason_chk" CHECK (
    ("event_code" = 'AUTHORIZE_RELEASE' AND "reason_code" IS NULL)
    OR ("event_code" <> 'AUTHORIZE_RELEASE' AND "reason_code" IS NOT NULL AND "reason_code" IN ('INTERNAL_DATA_REVIEW', 'INTERNAL_DOCUMENTATION_PENDING', 'INTERNAL_SUPERVISOR_DIRECTION', 'INTERNAL_CORRECTION_PENDING', 'INTERNAL_OTHER'))
  );

-- §4 — the database is the backstop behind every service check. An event:
-- * is recorded at the database's own transaction time (nothing backdated or postdated);
-- * takes exactly the next sequence of its frozen submission (no gap, no reuse; the unique key is the
--   backstop for two concurrent writers);
-- * is a legal A6-LIFECYCLE-1 edge from the disposition its submission is in now. Every earlier event passed
--   this guard, so the disposition is the one the latest event leads to (FROZEN when there is none):
--     FROZEN           -> PLACE_HOLD, AUTHORIZE_RELEASE, WITHDRAW_INTERNAL
--     HELD             -> RELEASE_HOLD, WITHDRAW_INTERNAL
--     RELEASE_ELIGIBLE -> PLACE_HOLD, WITHDRAW_INTERNAL
--     WITHDRAWN_INTERNAL -> nothing (terminal)
--   A forged direct INSERT of any other edge is refused.
CREATE OR REPLACE FUNCTION claim_freeze_lifecycle_events_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  submission_exists boolean;
  latest_sequence integer;
  latest_code text;
  current_disposition text;
BEGIN
  IF NEW."occurred_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'claim_lifecycle_time: a lifecycle event is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (SELECT 1 FROM "claim_freezes" WHERE "id" = NEW."claim_submission_id") INTO submission_exists;
  IF NOT submission_exists THEN
    RETURN NEW; -- the foreign key reports a missing frozen submission
  END IF;
  SELECT "sequence", "event_code" INTO latest_sequence, latest_code
  FROM "claim_freeze_lifecycle_events" WHERE "claim_submission_id" = NEW."claim_submission_id"
  ORDER BY "sequence" DESC LIMIT 1;
  IF NEW."sequence" IS DISTINCT FROM coalesce(latest_sequence, 0) + 1 THEN
    RAISE EXCEPTION 'claim_lifecycle_sequence: the sequence is not the next one of this frozen submission'
      USING ERRCODE = 'check_violation';
  END IF;
  current_disposition := CASE latest_code
    WHEN 'PLACE_HOLD' THEN 'HELD'
    WHEN 'RELEASE_HOLD' THEN 'FROZEN'
    WHEN 'AUTHORIZE_RELEASE' THEN 'RELEASE_ELIGIBLE'
    WHEN 'WITHDRAW_INTERNAL' THEN 'WITHDRAWN_INTERNAL'
    ELSE 'FROZEN'
  END;
  IF NOT (
    (current_disposition = 'FROZEN' AND NEW."event_code" IN ('PLACE_HOLD', 'AUTHORIZE_RELEASE', 'WITHDRAW_INTERNAL'))
    OR (current_disposition = 'HELD' AND NEW."event_code" IN ('RELEASE_HOLD', 'WITHDRAW_INTERNAL'))
    OR (current_disposition = 'RELEASE_ELIGIBLE' AND NEW."event_code" IN ('PLACE_HOLD', 'WITHDRAW_INTERNAL'))
  ) THEN
    RAISE EXCEPTION 'claim_lifecycle_transition: % is not allowed from %', NEW."event_code", current_disposition
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_freeze_lifecycle_events_insert_guard_trg
  BEFORE INSERT ON "claim_freeze_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_lifecycle_events_insert_guard();

-- §4 — a lifecycle event is evidence: never updated (not even a no-op update) and never deleted. A changed
-- disposition is a new event; a mistaken one is followed by the next legal event, never rewritten.
CREATE OR REPLACE FUNCTION claim_freeze_lifecycle_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_freeze_lifecycle_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_freeze_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_lifecycle_events_append_only();

-- There is deliberately no state column, current or latest pointer, sender, outbox, job, receipt,
-- external identifier, payer status, successor link or free-text remark.
