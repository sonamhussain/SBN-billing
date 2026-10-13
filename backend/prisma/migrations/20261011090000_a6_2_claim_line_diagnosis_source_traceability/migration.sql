-- A6.2 — Claim Line, Diagnosis & Source Traceability
--
-- Creates exactly four tables under the A6.1 Claim: claim_lines, claim_line_source_activities,
-- claim_diagnoses and claim_line_diagnosis_pointers, with their indexes, CHECKs, partial unique indexes
-- and integrity/history triggers. No price, rate, currency, lifecycle, approval, payload, submission,
-- transport, remittance or clinical HIE table or column. No applied A1-A6.1 migration is modified, and
-- the generated statements below were produced schema-to-schema with no unrelated drift.

-- CreateTable
CREATE TABLE "claim_lines" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "claim_line_contract_version" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_line_source_activities" (
    "id" UUID NOT NULL,
    "claim_line_id" UUID NOT NULL,
    "encounter_activity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_line_source_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_diagnoses" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "encounter_diagnosis_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role_code" TEXT NOT NULL,
    "claim_diagnosis_contract_version" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claim_diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_line_diagnosis_pointers" (
    "id" UUID NOT NULL,
    "claim_line_id" UUID NOT NULL,
    "claim_diagnosis_id" UUID NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "claim_line_diagnosis_pointers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "claim_lines_claim_id_removed_at_idx" ON "claim_lines"("claim_id", "removed_at");

-- CreateIndex
CREATE INDEX "claim_line_source_activities_encounter_activity_id_idx" ON "claim_line_source_activities"("encounter_activity_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_line_source_activities_claim_line_id_encounter_activi_key" ON "claim_line_source_activities"("claim_line_id", "encounter_activity_id");

-- CreateIndex
CREATE INDEX "claim_diagnoses_claim_id_removed_at_idx" ON "claim_diagnoses"("claim_id", "removed_at");

-- CreateIndex
CREATE INDEX "claim_diagnoses_encounter_diagnosis_id_idx" ON "claim_diagnoses"("encounter_diagnosis_id");

-- CreateIndex
CREATE INDEX "claim_line_diagnosis_pointers_claim_line_id_removed_at_idx" ON "claim_line_diagnosis_pointers"("claim_line_id", "removed_at");

-- CreateIndex
CREATE INDEX "claim_line_diagnosis_pointers_claim_diagnosis_id_removed_at_idx" ON "claim_line_diagnosis_pointers"("claim_diagnosis_id", "removed_at");

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line_source_activities" ADD CONSTRAINT "claim_line_source_activities_claim_line_id_fkey" FOREIGN KEY ("claim_line_id") REFERENCES "claim_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line_source_activities" ADD CONSTRAINT "claim_line_source_activities_encounter_activity_id_fkey" FOREIGN KEY ("encounter_activity_id") REFERENCES "encounter_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_diagnoses" ADD CONSTRAINT "claim_diagnoses_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_diagnoses" ADD CONSTRAINT "claim_diagnoses_encounter_diagnosis_id_fkey" FOREIGN KEY ("encounter_diagnosis_id") REFERENCES "encounter_diagnoses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_diagnoses" ADD CONSTRAINT "claim_diagnoses_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line_diagnosis_pointers" ADD CONSTRAINT "claim_line_diagnosis_pointers_claim_line_id_fkey" FOREIGN KEY ("claim_line_id") REFERENCES "claim_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line_diagnosis_pointers" ADD CONSTRAINT "claim_line_diagnosis_pointers_claim_diagnosis_id_fkey" FOREIGN KEY ("claim_diagnosis_id") REFERENCES "claim_diagnoses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_line_diagnosis_pointers" ADD CONSTRAINT "claim_line_diagnosis_pointers_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Hand-written integrity (A6.2 §7) ---------------------------------------------------------------

-- §7 — positions are 1-based, and the contract labels and role vocabulary are held by the database too.
-- A later line or diagnosis contract arrives with its own migration; an A6-LINE-1 or A6-DX-1 row is
-- never reinterpreted. Role count and applicability are deliberately NOT enforced here (A6.4 owns them).
ALTER TABLE "claim_lines"
  ADD CONSTRAINT "claim_lines_sequence_chk" CHECK ("sequence" >= 1);

ALTER TABLE "claim_lines"
  ADD CONSTRAINT "claim_lines_contract_version_chk" CHECK (
    "claim_line_contract_version" = 'A6-LINE-1'
    AND btrim("claim_line_contract_version") <> ''
    AND "claim_line_contract_version" = btrim("claim_line_contract_version")
    AND char_length("claim_line_contract_version") <= 96
  );

ALTER TABLE "claim_diagnoses"
  ADD CONSTRAINT "claim_diagnoses_sequence_chk" CHECK ("sequence" >= 1);

ALTER TABLE "claim_diagnoses"
  ADD CONSTRAINT "claim_diagnoses_contract_version_chk" CHECK (
    "claim_diagnosis_contract_version" = 'A6-DX-1'
    AND btrim("claim_diagnosis_contract_version") <> ''
    AND "claim_diagnosis_contract_version" = btrim("claim_diagnosis_contract_version")
    AND char_length("claim_diagnosis_contract_version") <= 96
  );

ALTER TABLE "claim_diagnoses"
  ADD CONSTRAINT "claim_diagnoses_role_code_chk" CHECK (
    "role_code" IN ('PRIMARY', 'SECONDARY', 'ADMITTING')
    AND "role_code" = btrim("role_code")
  );

-- §7 — two ACTIVE rows of one Claim never share a position, one EncounterDiagnosis is active at most
-- once per Claim, and one line points to one ClaimDiagnosis at most once while active. All partial:
-- removed history never blocks a later corrected re-add. The service rewrites positions in two phases
-- so these indexes are never disabled during a reorder.
CREATE UNIQUE INDEX "claim_lines_active_sequence_uidx"
  ON "claim_lines" ("claim_id", "sequence")
  WHERE "removed_at" IS NULL;

CREATE UNIQUE INDEX "claim_diagnoses_active_sequence_uidx"
  ON "claim_diagnoses" ("claim_id", "sequence")
  WHERE "removed_at" IS NULL;

CREATE UNIQUE INDEX "claim_diagnoses_active_source_uidx"
  ON "claim_diagnoses" ("claim_id", "encounter_diagnosis_id")
  WHERE "removed_at" IS NULL;

CREATE UNIQUE INDEX "claim_line_diagnosis_pointers_active_uidx"
  ON "claim_line_diagnosis_pointers" ("claim_line_id", "claim_diagnosis_id")
  WHERE "removed_at" IS NULL;

-- §7/§8 — the bound handoff reference set of a Claim. PreClaimA6HandoffV1.exactReferences lists the
-- EncounterActivity and EncounterDiagnosis ids named by the findings of the ValidationRun that the
-- Claim's readiness assessment assessed; this reads exactly those rows, through the immutable chain
-- Claim -> assessment -> run -> findings. It never looks at the current Encounter.
CREATE OR REPLACE FUNCTION claim_bound_run_id(target_claim_id uuid)
RETURNS uuid AS $$
  SELECT assessment."validation_run_id"
  FROM "claims" claim
  JOIN "pre_claim_readiness_assessments" assessment ON assessment."id" = claim."pre_claim_readiness_assessment_id"
  WHERE claim."id" = target_claim_id;
$$ LANGUAGE sql STABLE;

-- A new line is always active. Its removal is stamped later, once, by the history guard.
CREATE OR REPLACE FUNCTION claim_lines_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'claim_lines_insert_guard: a claim line is created active'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_lines_insert_guard_trg
  BEFORE INSERT ON "claim_lines"
  FOR EACH ROW EXECUTE FUNCTION claim_lines_insert_guard();

-- §4/§5 — A6-LINE-1: every line has exactly one source activity, recorded in the same transaction as
-- the line. Checked at commit, so the line and its source row are written as one unit.
CREATE OR REPLACE FUNCTION claim_lines_source_required()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT count(*) FROM "claim_line_source_activities" WHERE "claim_line_id" = NEW."id") <> 1 THEN
    RAISE EXCEPTION 'claim_lines_source_required: an A6-LINE-1 claim line has exactly one source activity'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER claim_lines_source_required_trg
  AFTER INSERT ON "claim_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION claim_lines_source_required();

-- §7 — the source binding of a line: the line is active and has no source yet (one per line in
-- A6-LINE-1), the EncounterActivity belongs to the Claim's own Encounter, it is in the bound handoff
-- reference set, and no other ACTIVE line of the same Claim already carries it. A same-Encounter but
-- unvalidated activity is refused.
CREATE OR REPLACE FUNCTION claim_line_source_activities_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  line_claim_id uuid;
  line_removed_at timestamptz;
  claim_encounter_id uuid;
  activity_encounter_id uuid;
BEGIN
  SELECT line."claim_id", line."removed_at", claim."encounter_id"
    INTO line_claim_id, line_removed_at, claim_encounter_id
  FROM "claim_lines" line
  JOIN "claims" claim ON claim."id" = line."claim_id"
  WHERE line."id" = NEW."claim_line_id";
  IF line_claim_id IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing line
  END IF;
  IF line_removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'claim_structure_inactive: a removed claim line cannot gain a source'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "claim_line_source_activities" WHERE "claim_line_id" = NEW."claim_line_id") THEN
    RAISE EXCEPTION 'claim_lines_source_required: an A6-LINE-1 claim line has exactly one source activity'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT activity."encounter_id" INTO activity_encounter_id
  FROM "encounter_activities" activity
  WHERE activity."id" = NEW."encounter_activity_id";
  IF activity_encounter_id IS NULL THEN
    RETURN NEW; -- the foreign key reports the missing activity
  END IF;
  IF activity_encounter_id IS DISTINCT FROM claim_encounter_id THEN
    RAISE EXCEPTION 'claim_source_encounter_mismatch: the encounter activity does not belong to the claim encounter'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "validation_findings" finding
    WHERE finding."validation_run_id" = claim_bound_run_id(line_claim_id)
      AND finding."encounter_activity_id" = NEW."encounter_activity_id"
  ) THEN
    RAISE EXCEPTION 'claim_source_not_in_handoff: the encounter activity is not in the bound handoff reference set'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "claim_line_source_activities" source
    JOIN "claim_lines" line ON line."id" = source."claim_line_id"
    WHERE line."claim_id" = line_claim_id
      AND line."removed_at" IS NULL
      AND source."encounter_activity_id" = NEW."encounter_activity_id"
  ) THEN
    RAISE EXCEPTION 'claim_line_source_already_active: another active line of this claim already carries this encounter activity'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_line_source_activities_insert_guard_trg
  BEFORE INSERT ON "claim_line_source_activities"
  FOR EACH ROW EXECUTE FUNCTION claim_line_source_activities_insert_guard();

-- §17 — a source row explains where a historical line came from. It is never changed or deleted.
CREATE OR REPLACE FUNCTION claim_line_source_activities_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'claim_line_source_activities is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_line_source_activities_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_line_source_activities"
  FOR EACH ROW EXECUTE FUNCTION claim_line_source_activities_append_only();

-- §7 — a claim diagnosis is created active, for an EncounterDiagnosis of the Claim's own Encounter that
-- is in the bound handoff reference set.
CREATE OR REPLACE FUNCTION claim_diagnoses_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  claim_encounter_id uuid;
  diagnosis_encounter_id uuid;
BEGIN
  IF NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'claim_diagnoses_insert_guard: a claim diagnosis is created active'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT claim."encounter_id" INTO claim_encounter_id FROM "claims" claim WHERE claim."id" = NEW."claim_id";
  SELECT diagnosis."encounter_id" INTO diagnosis_encounter_id
  FROM "encounter_diagnoses" diagnosis
  WHERE diagnosis."id" = NEW."encounter_diagnosis_id";
  IF claim_encounter_id IS NULL OR diagnosis_encounter_id IS NULL THEN
    RETURN NEW; -- the foreign keys report a missing claim or diagnosis
  END IF;
  IF diagnosis_encounter_id IS DISTINCT FROM claim_encounter_id THEN
    RAISE EXCEPTION 'claim_source_encounter_mismatch: the encounter diagnosis does not belong to the claim encounter'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "validation_findings" finding
    WHERE finding."validation_run_id" = claim_bound_run_id(NEW."claim_id")
      AND finding."encounter_diagnosis_id" = NEW."encounter_diagnosis_id"
  ) THEN
    RAISE EXCEPTION 'claim_source_not_in_handoff: the encounter diagnosis is not in the bound handoff reference set'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_diagnoses_insert_guard_trg
  BEFORE INSERT ON "claim_diagnoses"
  FOR EACH ROW EXECUTE FUNCTION claim_diagnoses_insert_guard();

-- §7/§11 — a pointer is created active, between an ACTIVE line and an ACTIVE diagnosis of the SAME Claim.
CREATE OR REPLACE FUNCTION claim_line_diagnosis_pointers_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  line_claim_id uuid;
  line_removed_at timestamptz;
  diagnosis_claim_id uuid;
  diagnosis_removed_at timestamptz;
BEGIN
  IF NEW."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'claim_line_diagnosis_pointers_insert_guard: a pointer is created active'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "claim_id", "removed_at" INTO line_claim_id, line_removed_at FROM "claim_lines" WHERE "id" = NEW."claim_line_id";
  SELECT "claim_id", "removed_at" INTO diagnosis_claim_id, diagnosis_removed_at FROM "claim_diagnoses" WHERE "id" = NEW."claim_diagnosis_id";
  IF line_claim_id IS NULL OR diagnosis_claim_id IS NULL THEN
    RETURN NEW; -- the foreign keys report a missing line or diagnosis
  END IF;
  IF line_claim_id IS DISTINCT FROM diagnosis_claim_id THEN
    RAISE EXCEPTION 'claim_diagnosis_pointer_mismatch: the line and the diagnosis belong to different claims'
      USING ERRCODE = 'check_violation';
  END IF;
  IF line_removed_at IS NOT NULL OR diagnosis_removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'claim_structure_inactive: a pointer needs an active line and an active diagnosis'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_line_diagnosis_pointers_insert_guard_trg
  BEFORE INSERT ON "claim_line_diagnosis_pointers"
  FOR EACH ROW EXECUTE FUNCTION claim_line_diagnosis_pointers_insert_guard();

-- §7/§17 — one-way history. Nothing is ever deleted. Identity, source, role, contract, creator and
-- createdAt never change. While active, a line or diagnosis may only move position (reorder/compaction)
-- or be removed; removal keeps its last position and the database stamps removed_at with its own
-- transaction time, once. A removed row never changes again and is never restored.
CREATE OR REPLACE FUNCTION claim_lines_history_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_lines cannot be deleted; remove the line instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."claim_id" IS DISTINCT FROM OLD."claim_id"
     OR NEW."claim_line_contract_version" IS DISTINCT FROM OLD."claim_line_contract_version"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'claim_lines identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'claim_structure_inactive: a removed claim line cannot be changed or restored'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."removed_at" IS NOT NULL THEN
    IF NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
      RAISE EXCEPTION 'claim_lines: a removal keeps the last position'
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW."removed_at" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_lines_history_guard_trg
  BEFORE UPDATE OR DELETE ON "claim_lines"
  FOR EACH ROW EXECUTE FUNCTION claim_lines_history_guard();

CREATE OR REPLACE FUNCTION claim_diagnoses_history_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_diagnoses cannot be deleted; remove the diagnosis instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."claim_id" IS DISTINCT FROM OLD."claim_id"
     OR NEW."encounter_diagnosis_id" IS DISTINCT FROM OLD."encounter_diagnosis_id"
     OR NEW."role_code" IS DISTINCT FROM OLD."role_code"
     OR NEW."claim_diagnosis_contract_version" IS DISTINCT FROM OLD."claim_diagnosis_contract_version"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'claim_diagnoses identity, source and role are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'claim_structure_inactive: a removed claim diagnosis cannot be changed or restored'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."removed_at" IS NOT NULL THEN
    IF NEW."sequence" IS DISTINCT FROM OLD."sequence" THEN
      RAISE EXCEPTION 'claim_diagnoses: a removal keeps the last position'
        USING ERRCODE = 'restrict_violation';
    END IF;
    NEW."removed_at" := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_diagnoses_history_guard_trg
  BEFORE UPDATE OR DELETE ON "claim_diagnoses"
  FOR EACH ROW EXECUTE FUNCTION claim_diagnoses_history_guard();

CREATE OR REPLACE FUNCTION claim_line_diagnosis_pointers_history_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'claim_line_diagnosis_pointers cannot be deleted; remove the pointer instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."claim_line_id" IS DISTINCT FROM OLD."claim_line_id"
     OR NEW."claim_diagnosis_id" IS DISTINCT FROM OLD."claim_diagnosis_id"
     OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'claim_line_diagnosis_pointers identity is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."removed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'claim_structure_inactive: a removed pointer cannot be changed or restored'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."removed_at" IS NULL THEN
    RAISE EXCEPTION 'claim_line_diagnosis_pointers: the only permitted change is removing the pointer once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW."removed_at" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_line_diagnosis_pointers_history_guard_trg
  BEFORE UPDATE OR DELETE ON "claim_line_diagnosis_pointers"
  FOR EACH ROW EXECUTE FUNCTION claim_line_diagnosis_pointers_history_guard();

-- There is deliberately no service, procedure, quantity, unit, modifier, diagnosis code or text,
-- pointer-order, price, currency, state, approval, payload, hash, submission, DHPO/eClaimLink/XML,
-- X12/NPI or NABIDH/Malaffi/Riayati column in any A6.2 table.
