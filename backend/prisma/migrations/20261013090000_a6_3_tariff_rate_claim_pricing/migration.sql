-- A6.3 — Tariff Rate & Claim Pricing Foundation
--
-- Creates exactly three tables: tariff_rates (A6-RATE-1), claim_pricing_runs and
-- claim_pricing_line_results (A6-PRICE-1), with their indexes, CHECKs, partial unique index and
-- integrity/history triggers. No applied migration is modified, and the generated statements below were
-- produced schema-to-schema with no unrelated drift. No patient share, Net, approval, payload,
-- submission, transport or clinical HIE table or column.

-- CreateTable
CREATE TABLE "tariff_rates" (
    "id" UUID NOT NULL,
    "tariff_schedule_version_id" UUID NOT NULL,
    "selector_kind" TEXT NOT NULL,
    "service_id" UUID,
    "procedure_code_id" UUID,
    "unit_code_key" TEXT,
    "modifier_signature" TEXT[],
    "currency_code" TEXT NOT NULL,
    "unit_tariff_amount" DECIMAL(18,4) NOT NULL,
    "rate_contract_version" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tariff_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_pricing_runs" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "pricing_contract_version" TEXT NOT NULL,
    "tariff_schedule_version_id" UUID NOT NULL,
    "provider_contract_id" UUID NOT NULL,
    "tariff_schedule_id" UUID NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "input_structure_fingerprint" TEXT NOT NULL,
    "overall_result" TEXT NOT NULL,
    "line_count" INTEGER NOT NULL,
    "priced_count" INTEGER NOT NULL,
    "currency_code" TEXT,
    "total_extended_amount" DECIMAL(18,4),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_pricing_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_pricing_line_results" (
    "id" UUID NOT NULL,
    "pricing_run_id" UUID NOT NULL,
    "claim_line_id" UUID NOT NULL,
    "encounter_activity_id" UUID NOT NULL,
    "tariff_rate_id" UUID,
    "line_sequence_at_evaluation" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "unit_tariff_amount" DECIMAL(18,4),
    "quantity_at_evaluation" DECIMAL(18,4) NOT NULL,
    "extended_amount" DECIMAL(18,4),
    "currency_code" TEXT,
    "input_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_pricing_line_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tariff_rates_tariff_schedule_version_id_removed_at_idx" ON "tariff_rates"("tariff_schedule_version_id", "removed_at");

-- CreateIndex
CREATE INDEX "tariff_rates_service_id_idx" ON "tariff_rates"("service_id");

-- CreateIndex
CREATE INDEX "tariff_rates_procedure_code_id_idx" ON "tariff_rates"("procedure_code_id");

-- CreateIndex
CREATE INDEX "claim_pricing_runs_claim_id_evaluated_at_idx" ON "claim_pricing_runs"("claim_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "claim_pricing_runs_tariff_schedule_version_id_idx" ON "claim_pricing_runs"("tariff_schedule_version_id");

-- CreateIndex
CREATE INDEX "claim_pricing_line_results_claim_line_id_idx" ON "claim_pricing_line_results"("claim_line_id");

-- CreateIndex
CREATE INDEX "claim_pricing_line_results_tariff_rate_id_idx" ON "claim_pricing_line_results"("tariff_rate_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_pricing_line_results_pricing_run_id_claim_line_id_key" ON "claim_pricing_line_results"("pricing_run_id", "claim_line_id");

-- AddForeignKey
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_tariff_schedule_version_id_fkey" FOREIGN KEY ("tariff_schedule_version_id") REFERENCES "tariff_schedule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_procedure_code_id_fkey" FOREIGN KEY ("procedure_code_id") REFERENCES "procedure_codes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tariff_rates" ADD CONSTRAINT "tariff_rates_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_runs" ADD CONSTRAINT "claim_pricing_runs_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_runs" ADD CONSTRAINT "claim_pricing_runs_tariff_schedule_version_id_fkey" FOREIGN KEY ("tariff_schedule_version_id") REFERENCES "tariff_schedule_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_runs" ADD CONSTRAINT "claim_pricing_runs_provider_contract_id_fkey" FOREIGN KEY ("provider_contract_id") REFERENCES "provider_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_runs" ADD CONSTRAINT "claim_pricing_runs_tariff_schedule_id_fkey" FOREIGN KEY ("tariff_schedule_id") REFERENCES "tariff_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_runs" ADD CONSTRAINT "claim_pricing_runs_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_line_results" ADD CONSTRAINT "claim_pricing_line_results_pricing_run_id_fkey" FOREIGN KEY ("pricing_run_id") REFERENCES "claim_pricing_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_line_results" ADD CONSTRAINT "claim_pricing_line_results_claim_line_id_fkey" FOREIGN KEY ("claim_line_id") REFERENCES "claim_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_line_results" ADD CONSTRAINT "claim_pricing_line_results_encounter_activity_id_fkey" FOREIGN KEY ("encounter_activity_id") REFERENCES "encounter_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_pricing_line_results" ADD CONSTRAINT "claim_pricing_line_results_tariff_rate_id_fkey" FOREIGN KEY ("tariff_rate_id") REFERENCES "tariff_rates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity (A6.3 §4, §5) ------------------------------------------------------------

-- §4 — a rate names exactly one source identity of its declared kind, an uppercase ISO 4217 code, a
-- non-negative amount (an explicit 0.0000 is a real rate; there is no default), an exact unit that is
-- either absent or trimmed and non-blank, and the fixed contract label.
ALTER TABLE "tariff_rates"
  ADD CONSTRAINT "tariff_rates_selector_chk" CHECK (
    ("selector_kind" = 'SERVICE' AND "service_id" IS NOT NULL AND "procedure_code_id" IS NULL)
    OR ("selector_kind" = 'PROCEDURE_CODE' AND "procedure_code_id" IS NOT NULL AND "service_id" IS NULL)
  );

ALTER TABLE "tariff_rates"
  ADD CONSTRAINT "tariff_rates_currency_chk" CHECK ("currency_code" ~ '^[A-Z]{3}$');

ALTER TABLE "tariff_rates"
  ADD CONSTRAINT "tariff_rates_amount_chk" CHECK ("unit_tariff_amount" >= 0);

ALTER TABLE "tariff_rates"
  ADD CONSTRAINT "tariff_rates_unit_code_chk" CHECK (
    "unit_code_key" IS NULL OR ("unit_code_key" = btrim("unit_code_key") AND "unit_code_key" <> '')
  );

ALTER TABLE "tariff_rates"
  ADD CONSTRAINT "tariff_rates_contract_version_chk" CHECK ("rate_contract_version" = 'A6-RATE-1');

-- §4 — no two ACTIVE rates of one version share an exact identity. NULLS NOT DISTINCT makes "no unit" one
-- exact value instead of letting two NULL units coexist. Removed history never blocks a corrected re-add.
CREATE UNIQUE INDEX "tariff_rates_active_identity_uidx"
  ON "tariff_rates" ("tariff_schedule_version_id", "selector_kind", "service_id", "procedure_code_id", "unit_code_key", "modifier_signature")
  NULLS NOT DISTINCT
  WHERE "removed_at" IS NULL;

-- §3/§8 — a rate is written only into an UNVERIFIED version of a contract of its source master's own
-- organization, created active, with a canonical modifier signature: trimmed, non-blank, unique and sorted
-- ascending (the empty set is a valid signature). The version row is locked by every rate writer and by
-- the REF-01 verification writer, so a rate can never slip into a version while it is being verified.
CREATE OR REPLACE FUNCTION tariff_rates_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  version_status text;
  contract_org uuid;
  master_org uuid;
BEGIN
  IF NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'tariff_rates_insert_guard: a tariff rate is created active'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."modifier_signature" IS NULL THEN
    RAISE EXCEPTION 'tariff_rates_modifier_signature: the modifier signature is an array, possibly empty'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW."modifier_signature") AS code WHERE code IS NULL OR code <> btrim(code) OR code = '')
     OR NEW."modifier_signature" IS DISTINCT FROM ARRAY(SELECT code FROM (SELECT DISTINCT code FROM unnest(NEW."modifier_signature") AS code) AS distinct_codes ORDER BY code COLLATE "C") THEN
    RAISE EXCEPTION 'tariff_rates_modifier_signature: modifier codes must be trimmed, non-blank, unique and sorted'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT version."verification_status", contract."organization_id" INTO version_status, contract_org
  FROM "tariff_schedule_versions" version
  JOIN "tariff_schedules" schedule ON schedule."id" = version."tariff_schedule_id"
  JOIN "provider_contracts" contract ON contract."id" = schedule."provider_contract_id"
  WHERE version."id" = NEW."tariff_schedule_version_id";
  IF version_status IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing version
  END IF;
  IF version_status <> 'UNVERIFIED' THEN
    RAISE EXCEPTION 'rate_version_locked: rates are written only into an UNVERIFIED tariff version'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."service_id" IS NOT NULL THEN
    SELECT "organization_id" INTO master_org FROM "services" WHERE "id" = NEW."service_id";
  ELSE
    SELECT "organization_id" INTO master_org FROM "procedure_codes" WHERE "id" = NEW."procedure_code_id";
  END IF;
  IF master_org IS NOT NULL AND master_org IS DISTINCT FROM contract_org THEN
    RAISE EXCEPTION 'tariff_rates_scope: the rated service or procedure belongs to another organization'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tariff_rates_insert_guard_trg
  BEFORE INSERT ON "tariff_rates"
  FOR EACH ROW EXECUTE FUNCTION tariff_rates_insert_guard();

-- §3/§8 — a rate is never deleted and its identity and amount never change. The only change is one
-- retirement, stamped by the database, while the parent version is still UNVERIFIED.
CREATE OR REPLACE FUNCTION tariff_rates_history_guard()
RETURNS TRIGGER AS $$
DECLARE
  version_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tariff_rates cannot be deleted; retire the rate instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tariff_schedule_version_id" IS DISTINCT FROM OLD."tariff_schedule_version_id"
     OR NEW."selector_kind" IS DISTINCT FROM OLD."selector_kind"
     OR NEW."service_id" IS DISTINCT FROM OLD."service_id"
     OR NEW."procedure_code_id" IS DISTINCT FROM OLD."procedure_code_id"
     OR NEW."unit_code_key" IS DISTINCT FROM OLD."unit_code_key"
     OR NEW."modifier_signature" IS DISTINCT FROM OLD."modifier_signature"
     OR NEW."currency_code" IS DISTINCT FROM OLD."currency_code"
     OR NEW."unit_tariff_amount" IS DISTINCT FROM OLD."unit_tariff_amount"
     OR NEW."rate_contract_version" IS DISTINCT FROM OLD."rate_contract_version"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'tariff_rates identity and amount are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'tariff_rates: a retired rate cannot be changed or restored'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."removed_at" IS NULL THEN
    RAISE EXCEPTION 'tariff_rates: the only permitted change is retiring the rate once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "verification_status" INTO version_status FROM "tariff_schedule_versions" WHERE "id" = OLD."tariff_schedule_version_id";
  IF version_status IS DISTINCT FROM 'UNVERIFIED' THEN
    RAISE EXCEPTION 'rate_version_locked: rates of a version that is no longer UNVERIFIED cannot be retired'
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW."removed_at" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tariff_rates_history_guard_trg
  BEFORE UPDATE OR DELETE ON "tariff_rates"
  FOR EACH ROW EXECUTE FUNCTION tariff_rates_history_guard();

-- §5/§6 — a pricing run carries its fixed contract and a coherent result: PRICED means at least one
-- line, every line priced, one currency and a non-negative total; INCOMPLETE never advertises a total.
ALTER TABLE "claim_pricing_runs"
  ADD CONSTRAINT "claim_pricing_runs_contract_version_chk" CHECK ("pricing_contract_version" = 'A6-PRICE-1');

ALTER TABLE "claim_pricing_runs"
  ADD CONSTRAINT "claim_pricing_runs_counts_chk" CHECK ("line_count" >= 0 AND "priced_count" >= 0 AND "priced_count" <= "line_count");

ALTER TABLE "claim_pricing_runs"
  ADD CONSTRAINT "claim_pricing_runs_result_chk" CHECK (
    ("overall_result" = 'PRICED'
      AND "line_count" > 0 AND "priced_count" = "line_count"
      AND "currency_code" ~ '^[A-Z]{3}$' AND "total_extended_amount" IS NOT NULL AND "total_extended_amount" >= 0)
    OR ("overall_result" = 'INCOMPLETE' AND "total_extended_amount" IS NULL AND "currency_code" IS NULL)
  );

ALTER TABLE "claim_pricing_runs"
  ADD CONSTRAINT "claim_pricing_runs_fingerprint_chk" CHECK ("input_structure_fingerprint" ~ '^[0-9a-f]{64}$');

-- §7 — a run evaluates exactly the commercial lineage of its Claim's bound ValidationRun: the same
-- contract, schedule and version, coherent by ancestry. A run against any other tariff is refused.
CREATE OR REPLACE FUNCTION claim_pricing_runs_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  bound_contract uuid;
  bound_schedule uuid;
  bound_version uuid;
  version_schedule uuid;
  schedule_contract uuid;
BEGIN
  SELECT run."provider_contract_id", run."tariff_schedule_id", run."tariff_schedule_version_id"
    INTO bound_contract, bound_schedule, bound_version
  FROM "claims" claim
  JOIN "pre_claim_readiness_assessments" assessment ON assessment."id" = claim."pre_claim_readiness_assessment_id"
  JOIN "validation_runs" run ON run."id" = assessment."validation_run_id"
  WHERE claim."id" = NEW."claim_id";
  SELECT "tariff_schedule_id" INTO version_schedule FROM "tariff_schedule_versions" WHERE "id" = NEW."tariff_schedule_version_id";
  SELECT "provider_contract_id" INTO schedule_contract FROM "tariff_schedules" WHERE "id" = NEW."tariff_schedule_id";
  IF bound_version IS DISTINCT FROM NEW."tariff_schedule_version_id"
     OR bound_schedule IS DISTINCT FROM NEW."tariff_schedule_id"
     OR bound_contract IS DISTINCT FROM NEW."provider_contract_id"
     OR version_schedule IS DISTINCT FROM NEW."tariff_schedule_id"
     OR schedule_contract IS DISTINCT FROM NEW."provider_contract_id" THEN
    RAISE EXCEPTION 'pricing_commercial_context_unresolved: the run does not price the exact commercial lineage bound to the claim'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_pricing_runs_insert_guard_trg
  BEFORE INSERT ON "claim_pricing_runs"
  FOR EACH ROW EXECUTE FUNCTION claim_pricing_runs_insert_guard();

-- §5 — a run and its line results are evaluation evidence: never updated, never deleted.
CREATE OR REPLACE FUNCTION claim_pricing_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_pricing_runs_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_pricing_runs"
  FOR EACH ROW EXECUTE FUNCTION claim_pricing_append_only();

CREATE TRIGGER claim_pricing_line_results_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_pricing_line_results"
  FOR EACH ROW EXECUTE FUNCTION claim_pricing_append_only();

-- §5/§6 — a line result is PRICED with exactly one rate, a unit amount, a rounded extended amount and a
-- currency, or it is unpriced with a reason and no rate or amount at all.
ALTER TABLE "claim_pricing_line_results"
  ADD CONSTRAINT "claim_pricing_line_results_outcome_chk" CHECK (
    ("outcome" = 'PRICED'
      AND "tariff_rate_id" IS NOT NULL AND "unit_tariff_amount" IS NOT NULL AND "unit_tariff_amount" >= 0
      AND "extended_amount" IS NOT NULL AND "extended_amount" >= 0 AND "currency_code" ~ '^[A-Z]{3}$')
    OR ("outcome" IN ('UNPRICED_RATE_MISSING', 'UNPRICED_RATE_AMBIGUOUS', 'UNPRICED_SOURCE_INVALID', 'UNPRICED_UNSUPPORTED_CURRENCY')
      AND "tariff_rate_id" IS NULL AND "unit_tariff_amount" IS NULL AND "extended_amount" IS NULL AND "currency_code" IS NULL)
  );

ALTER TABLE "claim_pricing_line_results"
  ADD CONSTRAINT "claim_pricing_line_results_quantity_chk" CHECK ("quantity_at_evaluation" > 0);

ALTER TABLE "claim_pricing_line_results"
  ADD CONSTRAINT "claim_pricing_line_results_sequence_chk" CHECK ("line_sequence_at_evaluation" >= 1);

ALTER TABLE "claim_pricing_line_results"
  ADD CONSTRAINT "claim_pricing_line_results_fingerprint_chk" CHECK ("input_fingerprint" ~ '^[0-9a-f]{64}$');

-- §5/§7 — a line result is written by the transaction that wrote its run (the run row's xmin is that
-- transaction and the run can never be updated), for an ACTIVE line of the run's Claim, with that line's
-- exact source activity, and, when priced, an active rate of the run's exact tariff version.
CREATE OR REPLACE FUNCTION claim_pricing_line_results_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  run_xmin xid;
  run_claim uuid;
  run_version uuid;
  line_claim uuid;
  line_removed timestamptz;
  rate_version uuid;
BEGIN
  SELECT xmin, "claim_id", "tariff_schedule_version_id" INTO run_xmin, run_claim, run_version
  FROM "claim_pricing_runs" WHERE "id" = NEW."pricing_run_id";
  IF run_xmin IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing run
  END IF;
  IF run_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'claim_pricing_line_results: a line result can only be recorded with its own run'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "claim_id", "removed_at" INTO line_claim, line_removed FROM "claim_lines" WHERE "id" = NEW."claim_line_id";
  IF line_claim IS DISTINCT FROM run_claim OR line_removed IS NOT NULL THEN
    RAISE EXCEPTION 'pricing_source_integrity: the line is not an active line of the priced claim'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "claim_line_source_activities"
    WHERE "claim_line_id" = NEW."claim_line_id" AND "encounter_activity_id" = NEW."encounter_activity_id"
  ) THEN
    RAISE EXCEPTION 'pricing_source_integrity: the activity is not the source of the line'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."tariff_rate_id" IS NOT NULL THEN
    SELECT "tariff_schedule_version_id" INTO rate_version FROM "tariff_rates"
    WHERE "id" = NEW."tariff_rate_id" AND "removed_at" IS NULL;
    IF rate_version IS DISTINCT FROM run_version THEN
      RAISE EXCEPTION 'pricing_source_integrity: the rate is not an active rate of the run tariff version'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_pricing_line_results_insert_guard_trg
  BEFORE INSERT ON "claim_pricing_line_results"
  FOR EACH ROW EXECUTE FUNCTION claim_pricing_line_results_insert_guard();

-- §5 — at commit, a run holds exactly line_count results, exactly priced_count of them PRICED, and a PRICED
-- run's total equals the sum of its rounded line amounts in its one currency. A run is never half-written.
CREATE OR REPLACE FUNCTION claim_pricing_runs_complete()
RETURNS TRIGGER AS $$
DECLARE
  total_lines integer;
  priced_lines integer;
  line_sum numeric;
  line_currencies integer;
  line_currency text;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE "outcome" = 'PRICED'), sum("extended_amount"),
         count(DISTINCT "currency_code"), min("currency_code")
    INTO total_lines, priced_lines, line_sum, line_currencies, line_currency
  FROM "claim_pricing_line_results" WHERE "pricing_run_id" = NEW."id";
  IF total_lines <> NEW."line_count" OR priced_lines <> NEW."priced_count" THEN
    RAISE EXCEPTION 'claim_pricing_runs_complete: the run does not hold exactly its declared line results'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."overall_result" = 'PRICED'
     AND (line_currencies <> 1 OR line_currency IS DISTINCT FROM NEW."currency_code" OR line_sum IS DISTINCT FROM NEW."total_extended_amount") THEN
    RAISE EXCEPTION 'claim_pricing_runs_complete: a PRICED total must be the sum of its lines in one currency'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER claim_pricing_runs_complete_trg
  AFTER INSERT ON "claim_pricing_runs"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION claim_pricing_runs_complete();

-- There is deliberately no patient share, payer Net, discount, tax, approval, lifecycle state, payload,
-- hash of a submitted claim, ClaimSubmission, DHPO/eClaimLink/XML, X12/NPI or NABIDH/Malaffi/Riayati
-- column, and no current-pricing-run pointer on the Claim.
