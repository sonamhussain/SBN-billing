-- A6.7 — Immutable ClaimSubmission & Claim Evidence Package
--
-- Creates exactly three append-only tables: claim_freezes (A6-SUBMISSION-1, the business ClaimSubmission),
-- claim_freeze_evidence_manifests (A6-EVIDENCE-1, the evidence package header with its canonical manifest
-- bytes, manifest digest and package seal) and claim_freeze_evidence_entries (its ordered, typed
-- references), with their indexes, CHECKs, coherence guards, append-only triggers and the commit-time
-- completeness check. No applied migration is modified, no existing table is altered, and the generated
-- statements below were produced schema-to-schema with no unrelated drift. The physical names avoid the
-- accepted A6.1–A6.6 phase guards; the API, contracts, audit and error names keep the business name.
--
-- A freeze is an internal custody record of exact approved bytes. It has no lifecycle state, no external
-- identifier, no acknowledgement and no outbound job; later packages own those separately.

-- CreateTable
CREATE TABLE "claim_freezes" (
    "id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "draft_assessment_id" UUID NOT NULL,
    "approval_review_event_id" UUID NOT NULL,
    "pricing_run_id" UUID NOT NULL,
    "submission_contract_version" TEXT NOT NULL,
    "payload_schema_version" TEXT NOT NULL,
    "approved_assembly_fingerprint" CHAR(64) NOT NULL,
    "canonical_payload_bytes" BYTEA NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "frozen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_freezes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_freeze_evidence_manifests" (
    "id" UUID NOT NULL,
    "claim_submission_id" UUID NOT NULL,
    "manifest_contract_version" TEXT NOT NULL,
    "entry_count" INTEGER NOT NULL,
    "manifest_bytes" BYTEA NOT NULL,
    "manifest_sha256" CHAR(64) NOT NULL,
    "package_seal_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_freeze_evidence_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "claim_freeze_evidence_entries" (
    "id" UUID NOT NULL,
    "evidence_package_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "reference_kind" TEXT NOT NULL,
    "reference_id" UUID NOT NULL,
    "reference_version_id" UUID,
    "content_hash" CHAR(64),
    "evidence_role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claim_freeze_evidence_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "claim_freezes_approval_review_event_id_key" ON "claim_freezes"("approval_review_event_id");

-- CreateIndex
CREATE INDEX "claim_freezes_claim_id_frozen_at_idx" ON "claim_freezes"("claim_id", "frozen_at");

-- CreateIndex
CREATE INDEX "claim_freezes_draft_assessment_id_idx" ON "claim_freezes"("draft_assessment_id");

-- CreateIndex
CREATE INDEX "claim_freezes_pricing_run_id_idx" ON "claim_freezes"("pricing_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_freeze_evidence_manifests_claim_submission_id_key" ON "claim_freeze_evidence_manifests"("claim_submission_id");

-- CreateIndex
CREATE UNIQUE INDEX "claim_freeze_evidence_entries_evidence_package_id_ordinal_key" ON "claim_freeze_evidence_entries"("evidence_package_id", "ordinal");

-- AddForeignKey
ALTER TABLE "claim_freezes" ADD CONSTRAINT "claim_freezes_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freezes" ADD CONSTRAINT "claim_freezes_draft_assessment_id_fkey" FOREIGN KEY ("draft_assessment_id") REFERENCES "claim_draft_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freezes" ADD CONSTRAINT "claim_freezes_approval_review_event_id_fkey" FOREIGN KEY ("approval_review_event_id") REFERENCES "claim_review_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freezes" ADD CONSTRAINT "claim_freezes_pricing_run_id_fkey" FOREIGN KEY ("pricing_run_id") REFERENCES "claim_pricing_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freezes" ADD CONSTRAINT "claim_freezes_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freeze_evidence_manifests" ADD CONSTRAINT "claim_freeze_evidence_manifests_claim_submission_id_fkey" FOREIGN KEY ("claim_submission_id") REFERENCES "claim_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "claim_freeze_evidence_entries" ADD CONSTRAINT "claim_freeze_evidence_entries_evidence_package_id_fkey" FOREIGN KEY ("evidence_package_id") REFERENCES "claim_freeze_evidence_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A6.7 §3, §4) -------------------------------------------------------------

-- §2/§3 — a freeze carries its fixed contracts, a 64-character lowercase SHA-256 approved fingerprint and
-- payload digest, and a non-empty canonical byte stream.
ALTER TABLE "claim_freezes"
  ADD CONSTRAINT "claim_freezes_contract_version_chk" CHECK ("submission_contract_version" = 'A6-SUBMISSION-1');

ALTER TABLE "claim_freezes"
  ADD CONSTRAINT "claim_freezes_payload_schema_version_chk" CHECK ("payload_schema_version" = 'A6-PAYLOAD-1');

ALTER TABLE "claim_freezes"
  ADD CONSTRAINT "claim_freezes_digest_shape_chk" CHECK (
    "approved_assembly_fingerprint" ~ '^[0-9a-f]{64}$' AND "payload_sha256" ~ '^[0-9a-f]{64}$' AND octet_length("canonical_payload_bytes") > 0
  );

-- §3/§4 — an evidence package carries its fixed contract, a non-negative entry count, non-empty manifest
-- bytes and 64-character lowercase SHA-256 manifest and seal digests.
ALTER TABLE "claim_freeze_evidence_manifests"
  ADD CONSTRAINT "claim_freeze_evidence_manifests_contract_version_chk" CHECK ("manifest_contract_version" = 'A6-EVIDENCE-1');

ALTER TABLE "claim_freeze_evidence_manifests"
  ADD CONSTRAINT "claim_freeze_evidence_manifests_shape_chk" CHECK (
    "entry_count" >= 0 AND octet_length("manifest_bytes") > 0 AND "manifest_sha256" ~ '^[0-9a-f]{64}$' AND "package_seal_sha256" ~ '^[0-9a-f]{64}$'
  );

-- §4 — the A6-EVIDENCE-1 reference vocabulary, in its fixed manifest order. The rank is the first manifest
-- sort key; references of one kind follow by reference id, then reference version id (absent first).
CREATE OR REPLACE FUNCTION claim_freeze_evidence_kind_rank(kind text)
RETURNS integer AS $$
  SELECT CASE kind
    WHEN 'VALIDATION_RUN' THEN 1
    WHEN 'READINESS_ASSESSMENT' THEN 2
    WHEN 'VALIDATION_FINDING' THEN 3
    WHEN 'ENCOUNTER_ACTIVITY' THEN 4
    WHEN 'ENCOUNTER_DIAGNOSIS' THEN 5
    WHEN 'ELIGIBILITY_VERIFICATION' THEN 6
    WHEN 'PRIOR_AUTHORIZATION_VERSION' THEN 7
    WHEN 'AUTHORIZATION_LINE' THEN 8
    WHEN 'EVIDENCE_REQUIREMENT' THEN 9
    WHEN 'EVIDENCE_ARTIFACT_VERSION' THEN 10
    WHEN 'RULE_VERSION' THEN 11
    WHEN 'RULE_SOURCE_VERSION' THEN 12
    WHEN 'REFERENCE_DATASET_VERSION' THEN 13
    WHEN 'PRICING_RUN' THEN 14
    WHEN 'PRICING_LINE_RESULT' THEN 15
    WHEN 'DRAFT_ASSESSMENT' THEN 16
    WHEN 'REVIEW_EVENT' THEN 17
  END
$$ LANGUAGE sql IMMUTABLE;

-- §3/§4 — each entry is one controlled kind with its one controlled role; a version id exactly for the
-- versioned kinds (the reference id is then the owner's parent id); and a content hash only for an evidence
-- artifact version, where its owner provides a SHA-256 — never invented for any other kind.
ALTER TABLE "claim_freeze_evidence_entries"
  ADD CONSTRAINT "claim_freeze_evidence_entries_ordinal_chk" CHECK ("ordinal" >= 1);

ALTER TABLE "claim_freeze_evidence_entries"
  ADD CONSTRAINT "claim_freeze_evidence_entries_kind_chk" CHECK (claim_freeze_evidence_kind_rank("reference_kind") IS NOT NULL);

ALTER TABLE "claim_freeze_evidence_entries"
  ADD CONSTRAINT "claim_freeze_evidence_entries_role_chk" CHECK (
    "evidence_role" = CASE
      WHEN "reference_kind" IN ('VALIDATION_RUN', 'READINESS_ASSESSMENT', 'VALIDATION_FINDING') THEN 'VALIDATION_BASIS'
      WHEN "reference_kind" = 'ENCOUNTER_ACTIVITY' THEN 'CLAIM_LINE_SOURCE'
      WHEN "reference_kind" = 'ENCOUNTER_DIAGNOSIS' THEN 'CLAIM_DIAGNOSIS_SOURCE'
      WHEN "reference_kind" = 'ELIGIBILITY_VERIFICATION' THEN 'COVERAGE_BASIS'
      WHEN "reference_kind" IN ('PRIOR_AUTHORIZATION_VERSION', 'AUTHORIZATION_LINE') THEN 'AUTHORIZATION_BASIS'
      WHEN "reference_kind" IN ('EVIDENCE_REQUIREMENT', 'EVIDENCE_ARTIFACT_VERSION') THEN 'DOCUMENTATION_BASIS'
      WHEN "reference_kind" IN ('RULE_VERSION', 'RULE_SOURCE_VERSION', 'REFERENCE_DATASET_VERSION') THEN 'RULE_PROVENANCE'
      WHEN "reference_kind" IN ('PRICING_RUN', 'PRICING_LINE_RESULT') THEN 'PRICING_BASIS'
      WHEN "reference_kind" = 'DRAFT_ASSESSMENT' THEN 'DRAFT_BASIS'
      WHEN "reference_kind" = 'REVIEW_EVENT' THEN 'HUMAN_APPROVAL'
    END
  );

ALTER TABLE "claim_freeze_evidence_entries"
  ADD CONSTRAINT "claim_freeze_evidence_entries_version_chk" CHECK (
    ("reference_version_id" IS NOT NULL) = ("reference_kind" IN ('PRIOR_AUTHORIZATION_VERSION', 'EVIDENCE_ARTIFACT_VERSION', 'RULE_VERSION', 'RULE_SOURCE_VERSION', 'REFERENCE_DATASET_VERSION'))
  );

ALTER TABLE "claim_freeze_evidence_entries"
  ADD CONSTRAINT "claim_freeze_evidence_entries_content_hash_chk" CHECK (
    ("reference_kind" = 'EVIDENCE_ARTIFACT_VERSION' AND "content_hash" IS NOT NULL AND "content_hash" ~ '^[0-9a-f]{64}$')
    OR ("reference_kind" <> 'EVIDENCE_ARTIFACT_VERSION' AND "content_hash" IS NULL)
  );

-- §2/§3/§5 — the database is the backstop behind every service check. A freeze:
-- * is recorded at the database's own transaction time (nothing backdated or postdated);
-- * names an assessment OF ITS OWN Claim (cross-Claim, and therefore cross-tenant, linkage is refused),
--   bound to the Claim's own readiness handoff, judged against exactly the named pricing run of that Claim,
--   REVIEWABLE, whose fingerprint is the approved one;
-- * names an APPROVE of that Claim, for that assessment, with that fingerprint, which is still the Claim's
--   latest review event (a returned, rejected, revoked or superseded approval freezes nothing);
-- * stores a payload digest that is exactly the SHA-256 of the stored bytes.
CREATE OR REPLACE FUNCTION claim_freezes_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  assessment_claim uuid;
  assessment_run uuid;
  assessment_outcome text;
  assessment_fingerprint text;
  assessment_handoff uuid;
  claim_handoff uuid;
  pricing_claim uuid;
  event_claim uuid;
  event_code text;
  event_assessment uuid;
  event_fingerprint text;
  event_sequence integer;
  latest_sequence integer;
BEGIN
  IF NEW."frozen_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'claim_freeze_time: a freeze is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "claim_id", "pricing_run_id", "outcome", "assembly_fingerprint", "handoff_assessment_id"
    INTO assessment_claim, assessment_run, assessment_outcome, assessment_fingerprint, assessment_handoff
  FROM "claim_draft_assessments" WHERE "id" = NEW."draft_assessment_id";
  SELECT "pre_claim_readiness_assessment_id" INTO claim_handoff FROM "claims" WHERE "id" = NEW."claim_id";
  SELECT "claim_id" INTO pricing_claim FROM "claim_pricing_runs" WHERE "id" = NEW."pricing_run_id";
  SELECT "claim_id", "decision_code", "draft_assessment_id", "approval_fingerprint", "sequence"
    INTO event_claim, event_code, event_assessment, event_fingerprint, event_sequence
  FROM "claim_review_events" WHERE "id" = NEW."approval_review_event_id";
  IF assessment_claim IS NULL OR claim_handoff IS NULL OR pricing_claim IS NULL OR event_claim IS NULL THEN
    RETURN NEW; -- the foreign keys report a missing Claim, assessment, pricing run or review event
  END IF;
  IF assessment_claim IS DISTINCT FROM NEW."claim_id" OR assessment_handoff IS DISTINCT FROM claim_handoff
     OR pricing_claim IS DISTINCT FROM NEW."claim_id" OR assessment_run IS DISTINCT FROM NEW."pricing_run_id" THEN
    RAISE EXCEPTION 'claim_freeze_coherence: the assessment and pricing run are not this claim''s own lineage'
      USING ERRCODE = 'check_violation';
  END IF;
  IF assessment_outcome IS DISTINCT FROM 'REVIEWABLE' OR assessment_fingerprint IS DISTINCT FROM NEW."approved_assembly_fingerprint" THEN
    RAISE EXCEPTION 'claim_freeze_coherence: only the approved fingerprint of a REVIEWABLE assessment can be frozen'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT max("sequence") INTO latest_sequence FROM "claim_review_events" WHERE "claim_id" = NEW."claim_id";
  IF event_claim IS DISTINCT FROM NEW."claim_id" OR event_code IS DISTINCT FROM 'APPROVE'
     OR event_assessment IS DISTINCT FROM NEW."draft_assessment_id" OR event_fingerprint IS DISTINCT FROM NEW."approved_assembly_fingerprint"
     OR event_sequence IS DISTINCT FROM latest_sequence THEN
    RAISE EXCEPTION 'claim_freeze_coherence: the review event is not this claim''s latest approval of the assessment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."payload_sha256" IS DISTINCT FROM encode(sha256(NEW."canonical_payload_bytes"), 'hex') THEN
    RAISE EXCEPTION 'claim_freeze_digest: the payload digest is not the SHA-256 of the stored bytes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_freezes_insert_guard_trg
  BEFORE INSERT ON "claim_freezes"
  FOR EACH ROW EXECUTE FUNCTION claim_freezes_insert_guard();

-- §4 — an evidence package is written only by the transaction that wrote its freeze (the freeze row's xmin
-- is that transaction, and the row can never be updated), at the database's own time. Its manifest digest
-- is the SHA-256 of its stored manifest bytes; the bytes are an A6-EVIDENCE-1 manifest of exactly this
-- freeze's identity and payload digest with exactly entry_count entries; and its seal is recomputed here:
--   SHA-256( UTF-8("SBN-A6-SUBMISSION-1\n") || payload digest (32 bytes) || manifest digest (32 bytes)
--            || claim id || draft assessment id || approval review event id || pricing run id )
-- with each id as its 16 RFC 4122 bytes.
CREATE OR REPLACE FUNCTION claim_freeze_evidence_manifests_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  freeze_xmin xid;
  freeze_claim uuid;
  freeze_assessment uuid;
  freeze_event uuid;
  freeze_run uuid;
  freeze_digest text;
  manifest jsonb;
BEGIN
  IF NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'claim_freeze_evidence_time: an evidence package is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT xmin, "claim_id", "draft_assessment_id", "approval_review_event_id", "pricing_run_id", "payload_sha256"
    INTO freeze_xmin, freeze_claim, freeze_assessment, freeze_event, freeze_run, freeze_digest
  FROM "claim_freezes" WHERE "id" = NEW."claim_submission_id";
  IF freeze_claim IS NULL THEN
    RETURN NEW; -- the foreign key reports a missing freeze
  END IF;
  IF freeze_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'claim_freeze_evidence_coherence: an evidence package can only be recorded with its own freeze'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."manifest_sha256" IS DISTINCT FROM encode(sha256(NEW."manifest_bytes"), 'hex') THEN
    RAISE EXCEPTION 'claim_freeze_evidence_digest: the manifest digest is not the SHA-256 of the stored manifest bytes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."package_seal_sha256" IS DISTINCT FROM encode(sha256(
       convert_to('SBN-A6-SUBMISSION-1' || chr(10), 'UTF8') || decode(freeze_digest, 'hex') || decode(NEW."manifest_sha256", 'hex')
       || uuid_send(freeze_claim) || uuid_send(freeze_assessment) || uuid_send(freeze_event) || uuid_send(freeze_run)), 'hex') THEN
    RAISE EXCEPTION 'claim_freeze_evidence_digest: the package seal is not the A6-SUBMISSION-1 seal of this freeze'
      USING ERRCODE = 'check_violation';
  END IF;
  manifest := convert_from(NEW."manifest_bytes", 'UTF8')::jsonb;
  IF jsonb_typeof(manifest) IS DISTINCT FROM 'object'
     OR (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(manifest) AS key)
        IS DISTINCT FROM ARRAY['approvalReviewEventId', 'claimId', 'draftAssessmentId', 'entries', 'payloadSha256', 'pricingRunId', 'schemaVersion']
     OR manifest->>'schemaVersion' IS DISTINCT FROM 'A6-EVIDENCE-1'
     OR manifest->>'claimId' IS DISTINCT FROM freeze_claim::text
     OR manifest->>'draftAssessmentId' IS DISTINCT FROM freeze_assessment::text
     OR manifest->>'approvalReviewEventId' IS DISTINCT FROM freeze_event::text
     OR manifest->>'pricingRunId' IS DISTINCT FROM freeze_run::text
     OR manifest->>'payloadSha256' IS DISTINCT FROM freeze_digest
     OR jsonb_typeof(manifest->'entries') IS DISTINCT FROM 'array'
     OR jsonb_array_length(manifest->'entries') IS DISTINCT FROM NEW."entry_count" THEN
    RAISE EXCEPTION 'claim_freeze_evidence_coherence: the manifest bytes are not the A6-EVIDENCE-1 manifest of this freeze'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_freeze_evidence_manifests_insert_guard_trg
  BEFORE INSERT ON "claim_freeze_evidence_manifests"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_evidence_manifests_insert_guard();

-- §4 — an evidence entry is written only by the transaction that wrote its package, at the database's own
-- time, and names exactly the historical lineage of its freeze — never a reference merely because its kind
-- exists:
-- * the validation run and readiness assessment are the ones the Claim's own handoff is bound to, and a
--   validation finding belongs to that run;
-- * an encounter activity is the source of a line result of the frozen pricing run; an encounter diagnosis
--   belongs to the Claim's encounter and is the source of one of the Claim's active diagnoses;
-- * every A5 reference (activity, diagnosis, eligibility, authorization version and line, evidence
--   requirement and artifact version, rule, source and reference dataset version) is named by a finding
--   of that run (a dataset version also through the finding's A5.8 consumed provenance);
-- * a versioned reference names its owner's parent as reference id, and an evidence artifact version
--   carries exactly its owner's content hash;
-- * the pricing run, its line results, the draft assessment and the review event are the frozen ones.
CREATE OR REPLACE FUNCTION claim_freeze_evidence_entries_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  package_xmin xid;
  freeze_id uuid;
  freeze_claim uuid;
  freeze_assessment uuid;
  freeze_event uuid;
  freeze_run uuid;
  claim_encounter uuid;
  claim_handoff uuid;
  handoff_run uuid;
  lineage_ok boolean;
BEGIN
  IF NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'claim_freeze_evidence_time: an evidence entry is recorded at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT xmin, "claim_submission_id" INTO package_xmin, freeze_id FROM "claim_freeze_evidence_manifests" WHERE "id" = NEW."evidence_package_id";
  IF freeze_id IS NULL THEN
    RETURN NEW; -- the foreign key reports a missing package
  END IF;
  IF package_xmin <> pg_current_xact_id()::xid THEN
    RAISE EXCEPTION 'claim_freeze_evidence_coherence: an evidence entry can only be recorded with its own package'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT f."claim_id", f."draft_assessment_id", f."approval_review_event_id", f."pricing_run_id", c."encounter_id", c."pre_claim_readiness_assessment_id", r."validation_run_id"
    INTO freeze_claim, freeze_assessment, freeze_event, freeze_run, claim_encounter, claim_handoff, handoff_run
  FROM "claim_freezes" f
  JOIN "claims" c ON c."id" = f."claim_id"
  JOIN "pre_claim_readiness_assessments" r ON r."id" = c."pre_claim_readiness_assessment_id"
  WHERE f."id" = freeze_id;

  lineage_ok := CASE NEW."reference_kind"
    WHEN 'VALIDATION_RUN' THEN NEW."reference_id" = handoff_run
    WHEN 'READINESS_ASSESSMENT' THEN NEW."reference_id" = claim_handoff
    WHEN 'VALIDATION_FINDING' THEN EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."id" = NEW."reference_id" AND vf."validation_run_id" = handoff_run)
    WHEN 'ENCOUNTER_ACTIVITY' THEN
      EXISTS (SELECT 1 FROM "claim_pricing_line_results" lr WHERE lr."pricing_run_id" = freeze_run AND lr."encounter_activity_id" = NEW."reference_id")
      AND EXISTS (SELECT 1 FROM "encounter_activities" ea WHERE ea."id" = NEW."reference_id" AND ea."encounter_id" = claim_encounter)
      AND EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."encounter_activity_id" = NEW."reference_id")
    WHEN 'ENCOUNTER_DIAGNOSIS' THEN
      EXISTS (SELECT 1 FROM "claim_diagnoses" cd WHERE cd."claim_id" = freeze_claim AND cd."encounter_diagnosis_id" = NEW."reference_id" AND cd."removed_at" IS NULL)
      AND EXISTS (SELECT 1 FROM "encounter_diagnoses" ed WHERE ed."id" = NEW."reference_id" AND ed."encounter_id" = claim_encounter)
      AND EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."encounter_diagnosis_id" = NEW."reference_id")
    WHEN 'ELIGIBILITY_VERIFICATION' THEN
      EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."eligibility_verification_id" = NEW."reference_id")
    WHEN 'PRIOR_AUTHORIZATION_VERSION' THEN
      EXISTS (SELECT 1 FROM "prior_authorization_versions" pv WHERE pv."id" = NEW."reference_version_id" AND pv."prior_authorization_id" = NEW."reference_id")
      AND EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."prior_authorization_version_id" = NEW."reference_version_id")
    WHEN 'AUTHORIZATION_LINE' THEN
      EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."authorization_line_id" = NEW."reference_id")
    WHEN 'EVIDENCE_REQUIREMENT' THEN
      EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."evidence_requirement_id" = NEW."reference_id")
    WHEN 'EVIDENCE_ARTIFACT_VERSION' THEN
      EXISTS (SELECT 1 FROM "evidence_artifact_versions" av WHERE av."id" = NEW."reference_version_id" AND av."evidence_artifact_id" = NEW."reference_id" AND av."content_hash" = NEW."content_hash")
      AND EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."evidence_artifact_version_id" = NEW."reference_version_id")
    WHEN 'RULE_VERSION' THEN
      EXISTS (SELECT 1 FROM "rule_versions" rv WHERE rv."id" = NEW."reference_version_id" AND rv."rule_id" = NEW."reference_id")
      AND EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."rule_version_id" = NEW."reference_version_id")
    WHEN 'RULE_SOURCE_VERSION' THEN
      EXISTS (SELECT 1 FROM "rule_source_versions" sv WHERE sv."id" = NEW."reference_version_id" AND sv."source_id" = NEW."reference_id")
      AND EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."governing_source_version_id" = NEW."reference_version_id")
    WHEN 'REFERENCE_DATASET_VERSION' THEN
      EXISTS (SELECT 1 FROM "reference_dataset_versions" dv WHERE dv."id" = NEW."reference_version_id" AND dv."dataset_id" = NEW."reference_id")
      AND (
        EXISTS (SELECT 1 FROM "validation_findings" vf WHERE vf."validation_run_id" = handoff_run AND vf."reference_dataset_version_id" = NEW."reference_version_id")
        OR EXISTS (
          SELECT 1 FROM "validation_finding_reference_dataset_versions" fd
          JOIN "validation_findings" vf ON vf."id" = fd."validation_finding_id"
          WHERE vf."validation_run_id" = handoff_run AND fd."reference_dataset_version_id" = NEW."reference_version_id"
        )
      )
    WHEN 'PRICING_RUN' THEN NEW."reference_id" = freeze_run
    WHEN 'PRICING_LINE_RESULT' THEN EXISTS (SELECT 1 FROM "claim_pricing_line_results" lr WHERE lr."id" = NEW."reference_id" AND lr."pricing_run_id" = freeze_run)
    WHEN 'DRAFT_ASSESSMENT' THEN NEW."reference_id" = freeze_assessment
    WHEN 'REVIEW_EVENT' THEN NEW."reference_id" = freeze_event
    ELSE false
  END;
  IF lineage_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'claim_freeze_evidence_coherence: the % reference is not part of this freeze''s historical lineage', NEW."reference_kind"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_freeze_evidence_entries_insert_guard_trg
  BEFORE INSERT ON "claim_freeze_evidence_entries"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_evidence_entries_insert_guard();

-- §3/§5 — a freeze commits only as one complete unit. Checked at commit, so the freeze, its package and its
-- entries are written in order inside one transaction: exactly one package; entry_count equal to the rows;
-- ordinals exactly 1..N; no reference twice; the rows in the A6-EVIDENCE-1 order (kind rank, reference id,
-- reference version id with absent first); and the rows exactly the entries of the stored manifest bytes.
CREATE OR REPLACE FUNCTION claim_freezes_require_evidence_package()
RETURNS TRIGGER AS $$
DECLARE
  package_id uuid;
  package_count integer;
  declared_count integer;
  manifest jsonb;
  row_count integer;
  max_ordinal integer;
  distinct_count integer;
  misordered integer;
  stored_entries jsonb;
BEGIN
  SELECT count(*) INTO package_count FROM "claim_freeze_evidence_manifests" WHERE "claim_submission_id" = NEW."id";
  IF package_count <> 1 THEN
    RAISE EXCEPTION 'claim_freeze_evidence_incomplete: a freeze is committed with exactly one evidence package'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT "id", "entry_count", convert_from("manifest_bytes", 'UTF8')::jsonb INTO package_id, declared_count, manifest
  FROM "claim_freeze_evidence_manifests" WHERE "claim_submission_id" = NEW."id";
  SELECT count(*), coalesce(max("ordinal"), 0), count(DISTINCT ("reference_kind", "reference_id", "reference_version_id"))
    INTO row_count, max_ordinal, distinct_count
  FROM "claim_freeze_evidence_entries" WHERE "evidence_package_id" = package_id;
  SELECT count(*) INTO misordered FROM (
    SELECT "ordinal", row_number() OVER (ORDER BY claim_freeze_evidence_kind_rank("reference_kind"), "reference_id", "reference_version_id" NULLS FIRST) AS expected
    FROM "claim_freeze_evidence_entries" WHERE "evidence_package_id" = package_id
  ) ordered WHERE "ordinal" <> expected;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'ordinal', "ordinal", 'referenceKind', "reference_kind", 'referenceId', "reference_id", 'referenceVersionId', "reference_version_id",
      'contentHash', "content_hash", 'evidenceRole', "evidence_role") ORDER BY "ordinal"), '[]'::jsonb)
    INTO stored_entries
  FROM "claim_freeze_evidence_entries" WHERE "evidence_package_id" = package_id;
  IF row_count <> declared_count OR max_ordinal <> row_count OR distinct_count <> row_count OR misordered <> 0
     OR stored_entries IS DISTINCT FROM manifest->'entries' THEN
    RAISE EXCEPTION 'claim_freeze_evidence_incomplete: the evidence entries are not exactly the ordered entries of the stored manifest'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER claim_freezes_require_evidence_package_trg
  AFTER INSERT ON "claim_freezes"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION claim_freezes_require_evidence_package();

-- §3 — a freeze, its package and its entries are evidence: never updated, never deleted. A new human
-- approval after a lawful correction supports a new freeze; nothing earlier is ever rewritten.
CREATE OR REPLACE FUNCTION claim_freeze_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER claim_freezes_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_freezes"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_append_only();

CREATE TRIGGER claim_freeze_evidence_manifests_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_freeze_evidence_manifests"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_append_only();

CREATE TRIGGER claim_freeze_evidence_entries_append_only_trg
  BEFORE UPDATE OR DELETE ON "claim_freeze_evidence_entries"
  FOR EACH ROW EXECUTE FUNCTION claim_freeze_append_only();

-- There is deliberately no lifecycle state, external claim identifier, acknowledgement, outbound job,
-- latest-freeze pointer or Claim column; no copied evidence bytes or upload table; and no free-text reason.
