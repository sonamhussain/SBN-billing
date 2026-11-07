-- CRG-01 FINAL Checkpoint B — versioned coding validation and freeze (design freeze revision 1.2)
--
-- Creates exactly three append-only CRG tables:
--   crg_validation_scopes            (CRG-VALSCOPE-1) the server-owned validator selection per (jurisdiction, authority);
--   crg_validation_code_receipts     (CRG-RECEIPT-1)  one immutable receipt per required coding target of an A5-VAL-2 run;
--   crg_validation_receipt_manifests (CRG-RECEIPT-1)  one manifest per A5-VAL-2 run.
-- It adds CRG-owned guards on two accepted tables (no column is added, no existing trigger is changed):
--   validation_runs: crg_validation_runs_scope_guard_trg (selection second line) and the deferred
--                    crg_validation_runs_receipts_complete_trg (an A5-VAL-2 run never commits without its manifest);
--   claim_freezes:   crg_claim_freezes_scope_guard_trg (no V1 freeze in a REGULATORY scope; a freeze's contract matches
--                    its Claim's handoff version; no freeze while a REGULATORY scope is SUSPENDED).
-- And it redefines, under their exact names and keeping every V1 value and rule, three version CHECKs:
--   claims_handoff_schema_version_chk, claim_freezes_payload_schema_version_chk, claim_freezes_contract_version_chk,
-- plus one new claim_freezes_version_pair_chk. No applied migration is modified and no historical row is touched.
--
-- Regulatory compliance remains NOT ESTABLISHED: this checkpoint admits SYNTHETIC scopes only
-- (crg_validation_scopes_checkpoint_b_chk); a REGULATORY row needs a separately approved activation migration.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. crg_validation_scopes (CRG-VALSCOPE-1)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "crg_validation_scopes" (
    "id" UUID NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "authority_code" TEXT NOT NULL,
    "scope_class" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "validator_version" TEXT NOT NULL,
    "scope_status" TEXT NOT NULL,
    "decision_reference" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_validation_scopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crg_validation_scopes_sequence_key" ON "crg_validation_scopes"("jurisdiction_code", "authority_code", "sequence");

ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_codes_chk" CHECK (
    "jurisdiction_code" = upper(btrim("jurisdiction_code")) AND char_length("jurisdiction_code") BETWEEN 1 AND 32
    AND "authority_code" = upper(btrim("authority_code")) AND char_length("authority_code") BETWEEN 1 AND 64
  );
-- A real authority code can never be SYNTHETIC, and a synthetic one never REGULATORY.
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_class_chk" CHECK (
    "scope_class" IN ('SYNTHETIC', 'REGULATORY') AND (("scope_class" = 'SYNTHETIC') = ("authority_code" LIKE 'SYN-%'))
  );
-- Checkpoint B: synthetic scopes only. Replacing this CHECK is the separately approved activation step.
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_checkpoint_b_chk" CHECK ("scope_class" = 'SYNTHETIC');
-- DISABLED is the synthetic rollback only; a REGULATORY scope rolls back to SUSPENDED, never to A5-VAL-1.
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_status_chk" CHECK (
    "scope_status" IN ('ENABLED', 'DISABLED', 'SUSPENDED')
    AND ("scope_status" <> 'DISABLED' OR "scope_class" = 'SYNTHETIC')
    AND ("scope_status" <> 'SUSPENDED' OR "scope_class" = 'REGULATORY')
  );
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_validator_chk" CHECK ("validator_version" = 'A5-VAL-2');
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_sequence_chk" CHECK ("sequence" >= 1);
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_reference_chk" CHECK (
    "decision_reference" = btrim("decision_reference") AND char_length("decision_reference") BETWEEN 1 AND 200
  );
ALTER TABLE "crg_validation_scopes"
  ADD CONSTRAINT "crg_validation_scopes_contract_chk" CHECK ("contract_version" = 'CRG-VALSCOPE-1');

-- Database time; the next number per scope; a scope never changes class; a REGULATORY scope starts ENABLED.
CREATE OR REPLACE FUNCTION crg_validation_scopes_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  latest RECORD;
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_validation_scope_time: a scope decision is recorded at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  SELECT s."sequence", s."scope_class" INTO latest
  FROM "crg_validation_scopes" s
  WHERE s."jurisdiction_code" = NEW."jurisdiction_code" AND s."authority_code" = NEW."authority_code"
  ORDER BY s."sequence" DESC LIMIT 1;
  IF NOT FOUND THEN
    IF NEW."sequence" <> 1 THEN
      RAISE EXCEPTION 'crg_validation_scope_sequence: the first decision of a scope is number 1' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."scope_class" = 'REGULATORY' AND NEW."scope_status" <> 'ENABLED' THEN
      RAISE EXCEPTION 'crg_validation_scope_one_way: a REGULATORY scope starts ENABLED' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."sequence" <> latest."sequence" + 1 THEN
      RAISE EXCEPTION 'crg_validation_scope_sequence: the next decision of this scope is number %', latest."sequence" + 1 USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."scope_class" IS DISTINCT FROM latest."scope_class" THEN
      RAISE EXCEPTION 'crg_validation_scope_one_way: a scope never changes class' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_validation_scopes_insert_guard_trg BEFORE INSERT ON "crg_validation_scopes"
  FOR EACH ROW EXECUTE FUNCTION crg_validation_scopes_insert_guard();

-- The latest decision of the scope of one facility regulatory profile (compared trimmed and upper-cased, as A3 and
-- Checkpoint A compare them), and whether that scope has ever had a REGULATORY decision. STABLE: reads only.
CREATE OR REPLACE FUNCTION crg_validation_scope_of_profile(profile_id uuid)
RETURNS TABLE (scope_class text, scope_status text, regulatory boolean) AS $$
  SELECT latest."scope_class", latest."scope_status",
         EXISTS (
           SELECT 1 FROM "crg_validation_scopes" r JOIN "facility_regulatory_profiles" p2 ON p2."id" = profile_id
           WHERE r."jurisdiction_code" = upper(btrim(p2."jurisdiction_code")) AND r."authority_code" = upper(btrim(p2."regulatory_authority_code"))
             AND r."scope_class" = 'REGULATORY'
         )
  FROM "facility_regulatory_profiles" p
  LEFT JOIN LATERAL (
    SELECT s."scope_class", s."scope_status" FROM "crg_validation_scopes" s
    WHERE s."jurisdiction_code" = upper(btrim(p."jurisdiction_code")) AND s."authority_code" = upper(btrim(p."regulatory_authority_code"))
    ORDER BY s."sequence" DESC LIMIT 1
  ) latest ON true
  WHERE p."id" = profile_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. crg_validation_code_receipts (CRG-RECEIPT-1)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "crg_validation_code_receipts" (
    "id" UUID NOT NULL,
    "validation_run_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "validation_finding_id" UUID NOT NULL,
    "subject_kind" TEXT NOT NULL,
    "encounter_diagnosis_id" UUID,
    "encounter_activity_id" UUID,
    "master_code_id" UUID NOT NULL,
    "code_system" TEXT,
    "canonical_code" TEXT,
    "decision_code" TEXT NOT NULL,
    "code_system_dataset_id" UUID,
    "release_import_id" UUID,
    "reference_dataset_version_id" UUID,
    "membership_id" UUID,
    "source_row_sha256" TEXT,
    "release_content_hash" TEXT,
    "membership_fingerprint_sha256" TEXT,
    "service_date" DATE NOT NULL,
    "jurisdiction_code" TEXT NOT NULL,
    "authority_code" TEXT NOT NULL,
    "algorithm_version" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_validation_code_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crg_validation_code_receipts_run_idx" ON "crg_validation_code_receipts"("validation_run_id");
CREATE INDEX "crg_validation_code_receipts_encounter_idx" ON "crg_validation_code_receipts"("encounter_id");
CREATE UNIQUE INDEX "crg_validation_code_receipts_finding_key" ON "crg_validation_code_receipts"("validation_finding_id");
CREATE UNIQUE INDEX "crg_validation_code_receipts_target_key" ON "crg_validation_code_receipts"("validation_run_id", "subject_kind", (COALESCE("encounter_diagnosis_id", "encounter_activity_id")));

ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_validation_run_id_fkey" FOREIGN KEY ("validation_run_id") REFERENCES "validation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "encounters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_validation_finding_id_fkey" FOREIGN KEY ("validation_finding_id") REFERENCES "validation_findings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_encounter_diagnosis_id_fkey" FOREIGN KEY ("encounter_diagnosis_id") REFERENCES "encounter_diagnoses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_encounter_activity_id_fkey" FOREIGN KEY ("encounter_activity_id") REFERENCES "encounter_activities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_code_system_dataset_id_fkey" FOREIGN KEY ("code_system_dataset_id") REFERENCES "crg_code_system_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_release_import_id_fkey" FOREIGN KEY ("release_import_id") REFERENCES "crg_release_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_reference_dataset_version_id_fkey" FOREIGN KEY ("reference_dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_code_receipts" ADD CONSTRAINT "crg_validation_code_receipts_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "crg_release_code_memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The exact target of the subject kind, and nothing else.
ALTER TABLE "crg_validation_code_receipts"
  ADD CONSTRAINT "crg_validation_code_receipts_target_chk" CHECK (
    ("subject_kind" = 'DIAGNOSIS' AND "encounter_diagnosis_id" IS NOT NULL AND "encounter_activity_id" IS NULL)
    OR ("subject_kind" = 'PROCEDURE' AND "encounter_activity_id" IS NOT NULL AND "encounter_diagnosis_id" IS NULL)
  );
-- The decision's exact basis: an edition only for APPLICABLE and CODE_NOT_IN_RELEASE, a membership only for
-- APPLICABLE; a code system and code together, absent only for AMBIGUOUS_CODE_SYSTEM and an unmapped
-- NO_APPROVED_RELEASE; never SOURCE_INTEGRITY_CONFLICT (an integrity defect writes no run).
ALTER TABLE "crg_validation_code_receipts"
  ADD CONSTRAINT "crg_validation_code_receipts_decision_chk" CHECK (
    "decision_code" IN ('APPLICABLE', 'CODE_NOT_IN_RELEASE', 'NO_APPROVED_RELEASE', 'CONFLICTING_RELEASES', 'RELEASE_NOT_AUTHORIZED', 'AMBIGUOUS_CODE_SYSTEM')
    AND (("code_system" IS NULL) = ("canonical_code" IS NULL))
    AND ("code_system" IS NOT NULL OR "decision_code" IN ('AMBIGUOUS_CODE_SYSTEM', 'NO_APPROVED_RELEASE'))
    AND ("code_system" IS NULL OR "code_system" IN ('ICD-10-CM', 'CPT', 'HCPCS-LEVEL-II'))
    AND ("code_system" IS NULL OR ("subject_kind" = 'DIAGNOSIS') = ("code_system" = 'ICD-10-CM'))
    AND ("decision_code" <> 'AMBIGUOUS_CODE_SYSTEM' OR "code_system" IS NULL)
    AND (("reference_dataset_version_id" IS NOT NULL) = ("decision_code" IN ('APPLICABLE', 'CODE_NOT_IN_RELEASE')))
    AND (("release_import_id" IS NOT NULL) = ("reference_dataset_version_id" IS NOT NULL))
    AND (("code_system_dataset_id" IS NOT NULL) = ("reference_dataset_version_id" IS NOT NULL))
    AND (("membership_fingerprint_sha256" IS NOT NULL) = ("reference_dataset_version_id" IS NOT NULL))
    AND (("membership_id" IS NOT NULL) = ("decision_code" = 'APPLICABLE'))
    AND (("source_row_sha256" IS NOT NULL) = ("membership_id" IS NOT NULL))
    AND (("release_content_hash" IS NOT NULL) = ("membership_id" IS NOT NULL))
    AND ("source_row_sha256" IS NULL OR "source_row_sha256" ~ '^[0-9a-f]{64}$')
    AND ("release_content_hash" IS NULL OR "release_content_hash" ~ '^[0-9a-f]{64}$')
    AND ("membership_fingerprint_sha256" IS NULL OR "membership_fingerprint_sha256" ~ '^[0-9a-f]{64}$')
    AND ("canonical_code" IS NULL OR "canonical_code" ~ '^[A-Z0-9][A-Z0-9.-]{0,31}$')
  );
ALTER TABLE "crg_validation_code_receipts"
  ADD CONSTRAINT "crg_validation_code_receipts_scope_chk" CHECK (
    "jurisdiction_code" = upper(btrim("jurisdiction_code")) AND char_length("jurisdiction_code") BETWEEN 1 AND 32
    AND "authority_code" = upper(btrim("authority_code")) AND char_length("authority_code") BETWEEN 1 AND 64
  );
ALTER TABLE "crg_validation_code_receipts"
  ADD CONSTRAINT "crg_validation_code_receipts_contract_chk" CHECK ("algorithm_version" = 'CRG-CODESET-1' AND "contract_version" = 'CRG-RECEIPT-1');

-- A receipt is written at database time, for an A5-VAL-2 run whose manifest does not exist yet (so nothing can be
-- added to a sealed run, in this transaction or a later one).
CREATE OR REPLACE FUNCTION crg_validation_code_receipts_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_receipt_time: a receipt is recorded at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "validation_runs" r WHERE r."id" = NEW."validation_run_id" AND r."validator_version" = 'A5-VAL-2') THEN
    RAISE EXCEPTION 'crg_receipt_run: a receipt belongs to an A5-VAL-2 validation run' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "crg_validation_receipt_manifests" m WHERE m."validation_run_id" = NEW."validation_run_id") THEN
    RAISE EXCEPTION 'crg_receipt_sealed: the run''s receipt manifest is already recorded; no receipt is added' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_validation_code_receipts_insert_guard_trg BEFORE INSERT ON "crg_validation_code_receipts"
  FOR EACH ROW EXECUTE FUNCTION crg_validation_code_receipts_insert_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 3. crg_validation_receipt_manifests (CRG-RECEIPT-1)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE "crg_validation_receipt_manifests" (
    "id" UUID NOT NULL,
    "validation_run_id" UUID NOT NULL,
    "receipt_count" INTEGER NOT NULL,
    "manifest_sha256" TEXT NOT NULL,
    "contract_version" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crg_validation_receipt_manifests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "crg_validation_receipt_manifests_run_key" ON "crg_validation_receipt_manifests"("validation_run_id");
ALTER TABLE "crg_validation_receipt_manifests" ADD CONSTRAINT "crg_validation_receipt_manifests_validation_run_id_fkey" FOREIGN KEY ("validation_run_id") REFERENCES "validation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crg_validation_receipt_manifests"
  ADD CONSTRAINT "crg_validation_receipt_manifests_shape_chk" CHECK (
    "receipt_count" >= 0 AND "manifest_sha256" ~ '^[0-9a-f]{64}$' AND "contract_version" = 'CRG-RECEIPT-1'
  );

CREATE OR REPLACE FUNCTION crg_validation_receipt_manifests_insert_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."recorded_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'crg_receipt_time: a manifest is recorded at the database''s own time' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "validation_runs" r WHERE r."id" = NEW."validation_run_id" AND r."validator_version" = 'A5-VAL-2') THEN
    RAISE EXCEPTION 'crg_receipt_run: a manifest belongs to an A5-VAL-2 validation run' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_validation_receipt_manifests_insert_guard_trg BEFORE INSERT ON "crg_validation_receipt_manifests"
  FOR EACH ROW EXECUTE FUNCTION crg_validation_receipt_manifests_insert_guard();

-- The canonical manifest line of one receipt: TAB-separated, '-' for NULL, LF-terminated (CRG-RECEIPT-1).
CREATE OR REPLACE FUNCTION crg_receipt_manifest_line(r "crg_validation_code_receipts")
RETURNS text AS $$
  SELECT concat_ws(E'\t',
    r."subject_kind", COALESCE(r."encounter_diagnosis_id", r."encounter_activity_id")::text, r."validation_finding_id"::text, r."master_code_id"::text,
    COALESCE(r."code_system", '-'), COALESCE(r."canonical_code", '-'), r."decision_code", COALESCE(r."code_system_dataset_id"::text, '-'),
    COALESCE(r."release_import_id"::text, '-'), COALESCE(r."reference_dataset_version_id"::text, '-'), COALESCE(r."membership_id"::text, '-'),
    COALESCE(r."source_row_sha256", '-')) || E'\n';
$$ LANGUAGE sql IMMUTABLE;

-- At commit: the integrity conditions I1–I6 of design freeze §6 for the whole run, against the live state of this one
-- transaction. Any failure refuses the commit.
CREATE OR REPLACE FUNCTION crg_validation_receipt_manifests_verify()
RETURNS TRIGGER AS $$
DECLARE
  run RECORD;
  technical_ok boolean;
  bad integer;
  digest text;
  receipts integer;
BEGIN
  SELECT r."id", r."encounter_id", r."service_date", r."validator_version", upper(btrim(p."jurisdiction_code")) AS jurisdiction_code, upper(btrim(p."regulatory_authority_code")) AS authority_code
    INTO run
  FROM "validation_runs" r JOIN "facility_regulatory_profiles" p ON p."id" = r."facility_regulatory_profile_id"
  WHERE r."id" = NEW."validation_run_id";
  -- I1 — an A5-VAL-2 run, and every receipt names its encounter.
  IF NOT FOUND OR run."validator_version" <> 'A5-VAL-2' THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I1 the manifest names no A5-VAL-2 run' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO bad FROM "crg_validation_code_receipts" c WHERE c."validation_run_id" = run."id" AND c."encounter_id" <> run."encounter_id";
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I1 a receipt names another encounter than its run' USING ERRCODE = 'check_violation';
  END IF;

  -- I2 — each target belongs to the encounter, is active, and the master and its canonical code are that target's.
  SELECT count(*) INTO bad
  FROM "crg_validation_code_receipts" c
  LEFT JOIN "encounter_diagnoses" d ON d."id" = c."encounter_diagnosis_id"
  LEFT JOIN "diagnosis_codes" dc ON dc."id" = d."diagnosis_code_id"
  LEFT JOIN "encounter_activities" a ON a."id" = c."encounter_activity_id"
  LEFT JOIN "procedure_codes" pc ON pc."id" = a."procedure_code_id"
  WHERE c."validation_run_id" = run."id" AND NOT (
    (c."subject_kind" = 'DIAGNOSIS' AND d."id" IS NOT NULL AND d."encounter_id" = run."encounter_id" AND d."removed_at" IS NULL
      AND c."master_code_id" = d."diagnosis_code_id"
      AND (c."canonical_code" IS NULL OR c."canonical_code" = upper(btrim(dc."code"))))
    OR (c."subject_kind" = 'PROCEDURE' AND a."id" IS NOT NULL AND a."encounter_id" = run."encounter_id" AND a."removed_at" IS NULL
      AND a."procedure_code_id" IS NOT NULL AND c."master_code_id" = a."procedure_code_id"
      AND (c."code_system" IS NULL OR (c."code_system" = pc."code_system" AND c."canonical_code" = upper(btrim(pc."external_code")))))
  );
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I2 a receipt target, master or code is not the encounter''s own' USING ERRCODE = 'check_violation';
  END IF;

  -- I3 — each receipt's finding belongs to the run, is CODING, names the same target, carries the finding code
  -- mapped from the decision and the same edition.
  SELECT count(*) INTO bad
  FROM "crg_validation_code_receipts" c
  LEFT JOIN "validation_findings" f ON f."id" = c."validation_finding_id"
  WHERE c."validation_run_id" = run."id" AND NOT (
    f."id" IS NOT NULL AND f."validation_run_id" = run."id" AND f."layer" = 'CODING'
    AND f."encounter_diagnosis_id" IS NOT DISTINCT FROM c."encounter_diagnosis_id" AND f."encounter_activity_id" IS NOT DISTINCT FROM c."encounter_activity_id"
    AND f."reference_dataset_version_id" IS NOT DISTINCT FROM c."reference_dataset_version_id"
    AND f."finding_code" = CASE c."decision_code"
      WHEN 'APPLICABLE' THEN 'CODING_RELEASE_APPLICABLE'
      WHEN 'CODE_NOT_IN_RELEASE' THEN 'CODING_RELEASE_CODE_NOT_IN_RELEASE'
      WHEN 'NO_APPROVED_RELEASE' THEN 'CODING_RELEASE_NO_APPROVED_RELEASE'
      WHEN 'CONFLICTING_RELEASES' THEN 'CODING_RELEASE_CONFLICTING'
      WHEN 'RELEASE_NOT_AUTHORIZED' THEN 'CODING_RELEASE_NOT_AUTHORIZED'
      WHEN 'AMBIGUOUS_CODE_SYSTEM' THEN 'CODING_RELEASE_AMBIGUOUS_CODE_SYSTEM'
    END
  );
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I3 a receipt does not explain its own coding finding' USING ERRCODE = 'check_violation';
  END IF;

  -- I4 — exact set equality: when the run's TECHNICAL layer passed, the required targets (active diagnoses and active
  -- coded activities) equal the receipt targets; otherwise there is no required target and no receipt. Every
  -- CODING_RELEASE_* finding has exactly one receipt.
  technical_ok := EXISTS (SELECT 1 FROM "validation_findings" f WHERE f."validation_run_id" = run."id" AND f."finding_code" = 'TECHNICAL_CONTEXT_VALID');
  SELECT count(*) INTO bad FROM (
    (SELECT 'DIAGNOSIS'::text AS kind, d."id" AS target FROM "encounter_diagnoses" d WHERE technical_ok AND d."encounter_id" = run."encounter_id" AND d."removed_at" IS NULL
     UNION ALL
     SELECT 'PROCEDURE'::text, a."id" FROM "encounter_activities" a WHERE technical_ok AND a."encounter_id" = run."encounter_id" AND a."removed_at" IS NULL AND a."procedure_code_id" IS NOT NULL)
    EXCEPT
    SELECT c."subject_kind", COALESCE(c."encounter_diagnosis_id", c."encounter_activity_id") FROM "crg_validation_code_receipts" c WHERE c."validation_run_id" = run."id"
  ) missing;
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I4 a required coding target has no receipt' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO bad FROM (
    SELECT c."subject_kind", COALESCE(c."encounter_diagnosis_id", c."encounter_activity_id") FROM "crg_validation_code_receipts" c WHERE c."validation_run_id" = run."id"
    EXCEPT
    (SELECT 'DIAGNOSIS'::text, d."id" FROM "encounter_diagnoses" d WHERE technical_ok AND d."encounter_id" = run."encounter_id" AND d."removed_at" IS NULL
     UNION ALL
     SELECT 'PROCEDURE'::text, a."id" FROM "encounter_activities" a WHERE technical_ok AND a."encounter_id" = run."encounter_id" AND a."removed_at" IS NULL AND a."procedure_code_id" IS NOT NULL)
  ) extra;
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I4 a receipt names a target that is not required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO bad
  FROM "validation_findings" f
  WHERE f."validation_run_id" = run."id" AND f."finding_code" LIKE 'CODING\_RELEASE\_%'
    AND NOT EXISTS (SELECT 1 FROM "crg_validation_code_receipts" c WHERE c."validation_finding_id" = f."id");
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I4 a coding-release finding has no receipt' USING ERRCODE = 'check_violation';
  END IF;

  -- I5 — release identity: membership → edition and code; edition → import → dataset mapping; the mapping's code
  -- system and scope; the run's scope and service date; the effective window; the copied hashes.
  SELECT count(*) INTO bad
  FROM "crg_validation_code_receipts" c
  LEFT JOIN "reference_dataset_versions" v ON v."id" = c."reference_dataset_version_id"
  LEFT JOIN "crg_release_imports" i ON i."id" = c."release_import_id"
  LEFT JOIN "crg_code_system_datasets" m ON m."id" = c."code_system_dataset_id"
  LEFT JOIN "reference_datasets" ds ON ds."id" = m."dataset_id"
  LEFT JOIN "crg_release_code_memberships" cm ON cm."id" = c."membership_id"
  WHERE c."validation_run_id" = run."id" AND NOT (
    c."service_date" = run."service_date" AND c."jurisdiction_code" = run.jurisdiction_code AND c."authority_code" = run.authority_code
    AND (c."reference_dataset_version_id" IS NULL OR (
      i."dataset_version_id" = v."id" AND i."code_system" = c."code_system" AND i."membership_fingerprint_sha256" = c."membership_fingerprint_sha256"
      AND m."dataset_id" = v."dataset_id" AND m."code_system" = c."code_system" AND m."purpose" = 'CLAIM_CODING'
      AND upper(btrim(m."jurisdiction_code")) = c."jurisdiction_code" AND upper(btrim(m."authority_code")) = c."authority_code"
      AND upper(btrim(ds."jurisdiction_code")) = c."jurisdiction_code" AND upper(btrim(ds."authority_code")) = c."authority_code"
      AND v."effective_from" IS NOT NULL AND v."effective_from" <= c."service_date" AND (v."effective_to" IS NULL OR v."effective_to" >= c."service_date")))
    AND (c."membership_id" IS NULL OR (
      cm."dataset_version_id" = c."reference_dataset_version_id" AND cm."import_id" = c."release_import_id" AND cm."code_system" = c."code_system"
      AND cm."code" = c."canonical_code" AND cm."source_row_sha256" = c."source_row_sha256" AND cm."release_content_hash" = c."release_content_hash"
      AND cm."release_content_hash" = v."content_hash"))
  );
  IF bad > 0 THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I5 a receipt''s release identity does not resolve to its edition, membership and scope' USING ERRCODE = 'check_violation';
  END IF;

  -- I6 — the manifest's count and digest, recomputed (a secondary check).
  SELECT count(*), encode(sha256(convert_to(COALESCE(string_agg(crg_receipt_manifest_line(c), '' ORDER BY c."subject_kind" COLLATE "C", COALESCE(c."encounter_diagnosis_id", c."encounter_activity_id")::text COLLATE "C"), ''), 'UTF8')), 'hex')
    INTO receipts, digest
  FROM "crg_validation_code_receipts" c WHERE c."validation_run_id" = run."id";
  IF receipts <> NEW."receipt_count" OR digest <> NEW."manifest_sha256" THEN
    RAISE EXCEPTION 'crg_receipt_integrity: I6 the manifest count or digest differs from the receipts' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER crg_validation_receipt_manifests_verify_trg AFTER INSERT ON "crg_validation_receipt_manifests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crg_validation_receipt_manifests_verify();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Guards on validation_runs (A5.7 table; CRG-owned; no column, no existing trigger changed)
-- ---------------------------------------------------------------------------------------------------------------
-- The selection's second line: an A5-VAL-2 run only where its scope's latest decision is ENABLED; in a scope that has
-- ever had a REGULATORY decision, no A5-VAL-1 run, and no run at all while it is SUSPENDED.
CREATE OR REPLACE FUNCTION crg_validation_runs_scope_guard()
RETURNS TRIGGER AS $$
DECLARE
  scope RECORD;
BEGIN
  SELECT * INTO scope FROM crg_validation_scope_of_profile(NEW."facility_regulatory_profile_id");
  IF NEW."validator_version" = 'A5-VAL-2' AND (scope.scope_status IS DISTINCT FROM 'ENABLED') THEN
    RAISE EXCEPTION 'crg_validation_scope: an A5-VAL-2 run needs an ENABLED validation scope' USING ERRCODE = 'check_violation';
  END IF;
  IF scope.regulatory AND NEW."validator_version" <> 'A5-VAL-2' THEN
    RAISE EXCEPTION 'crg_validation_scope: a REGULATORY coding scope accepts only A5-VAL-2 runs' USING ERRCODE = 'check_violation';
  END IF;
  IF scope.regulatory AND scope.scope_status = 'SUSPENDED' THEN
    RAISE EXCEPTION 'crg_validation_scope: the REGULATORY coding scope is SUSPENDED; no new run is recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_validation_runs_scope_guard_trg BEFORE INSERT ON "validation_runs"
  FOR EACH ROW EXECUTE FUNCTION crg_validation_runs_scope_guard();

-- At commit: an A5-VAL-2 run has its receipt manifest. Never acts on any other validator's run.
CREATE OR REPLACE FUNCTION crg_validation_runs_receipts_complete()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."validator_version" = 'A5-VAL-2'
     AND NOT EXISTS (SELECT 1 FROM "crg_validation_receipt_manifests" m WHERE m."validation_run_id" = NEW."id") THEN
    RAISE EXCEPTION 'crg_receipt_integrity: an A5-VAL-2 run commits only with its receipt manifest' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER crg_validation_runs_receipts_complete_trg AFTER INSERT ON "validation_runs"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION crg_validation_runs_receipts_complete();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Guard on claim_freezes (A6.7 table; CRG-owned)
-- ---------------------------------------------------------------------------------------------------------------
-- A freeze's contract matches its Claim's handoff (V1 with V1, V2 with V2); in a scope that has ever had a REGULATORY
-- decision no A6-SUBMISSION-1 freeze is recorded, and no freeze at all while it is SUSPENDED.
CREATE OR REPLACE FUNCTION crg_claim_freezes_scope_guard()
RETURNS TRIGGER AS $$
DECLARE
  claim RECORD;
  scope RECORD;
BEGIN
  SELECT c."handoff_schema_version", e."facility_regulatory_profile_id" INTO claim
  FROM "claims" c JOIN "encounters" e ON e."id" = c."encounter_id" WHERE c."id" = NEW."claim_id";
  IF NOT FOUND THEN
    RETURN NEW; -- the foreign key reports a missing Claim
  END IF;
  IF (NEW."submission_contract_version" = 'A6-SUBMISSION-2') <> (claim."handoff_schema_version" = 'PreClaimA6HandoffV2') THEN
    RAISE EXCEPTION 'crg_freeze_version: an A6-SUBMISSION-2 freeze belongs exactly to a PreClaimA6HandoffV2 claim' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO scope FROM crg_validation_scope_of_profile(claim."facility_regulatory_profile_id");
  IF scope.regulatory AND NEW."submission_contract_version" <> 'A6-SUBMISSION-2' THEN
    RAISE EXCEPTION 'crg_freeze_scope: a REGULATORY coding scope accepts only A6-SUBMISSION-2 freezes' USING ERRCODE = 'check_violation';
  END IF;
  IF scope.regulatory AND scope.scope_status = 'SUSPENDED' THEN
    RAISE EXCEPTION 'crg_freeze_scope: the REGULATORY coding scope is SUSPENDED; no new freeze is recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER crg_claim_freezes_scope_guard_trg BEFORE INSERT ON "claim_freezes"
  FOR EACH ROW EXECUTE FUNCTION crg_claim_freezes_scope_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. The three version CHECKs, redefined under their exact names (every V1 value and rule kept), and the pair CHECK
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE "claims" DROP CONSTRAINT "claims_handoff_schema_version_chk";
ALTER TABLE "claims"
  ADD CONSTRAINT "claims_handoff_schema_version_chk" CHECK (
    "handoff_schema_version" IN ('PreClaimA6HandoffV1', 'PreClaimA6HandoffV2')
    AND btrim("handoff_schema_version") <> '' AND "handoff_schema_version" = btrim("handoff_schema_version") AND char_length("handoff_schema_version") <= 96
  );
ALTER TABLE "claim_freezes" DROP CONSTRAINT "claim_freezes_payload_schema_version_chk";
ALTER TABLE "claim_freezes"
  ADD CONSTRAINT "claim_freezes_payload_schema_version_chk" CHECK ("payload_schema_version" IN ('A6-PAYLOAD-1', 'A6-PAYLOAD-2'));
ALTER TABLE "claim_freezes" DROP CONSTRAINT "claim_freezes_contract_version_chk";
ALTER TABLE "claim_freezes"
  ADD CONSTRAINT "claim_freezes_contract_version_chk" CHECK ("submission_contract_version" IN ('A6-SUBMISSION-1', 'A6-SUBMISSION-2'));
ALTER TABLE "claim_freezes"
  ADD CONSTRAINT "claim_freezes_version_pair_chk" CHECK (("submission_contract_version" = 'A6-SUBMISSION-1') = ("payload_schema_version" = 'A6-PAYLOAD-1'));

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Append-only and no TRUNCATE (the Checkpoint A function, reused)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TRIGGER crg_validation_scopes_append_only_trg BEFORE UPDATE OR DELETE ON "crg_validation_scopes" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_validation_scopes_no_truncate_trg BEFORE TRUNCATE ON "crg_validation_scopes" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_validation_code_receipts_append_only_trg BEFORE UPDATE OR DELETE ON "crg_validation_code_receipts" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_validation_code_receipts_no_truncate_trg BEFORE TRUNCATE ON "crg_validation_code_receipts" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_validation_receipt_manifests_append_only_trg BEFORE UPDATE OR DELETE ON "crg_validation_receipt_manifests" FOR EACH ROW EXECUTE FUNCTION crg_append_only();
CREATE TRIGGER crg_validation_receipt_manifests_no_truncate_trg BEFORE TRUNCATE ON "crg_validation_receipt_manifests" FOR EACH STATEMENT EXECUTE FUNCTION crg_append_only();

-- There is deliberately no REGULATORY row, no modifier evaluation, no DRG/pricing/payer column, no A7/A8/A9 table and no
-- column on any accepted A1–A8 table.
