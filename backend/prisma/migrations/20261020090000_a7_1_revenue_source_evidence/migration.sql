-- A7.1 — Revenue Evidence Intake & Provenance Foundation
--
-- Creates exactly one append-only table: revenue_source_evidence (A7-REVENUE-SOURCE-1), the immutable
-- registrations of revenue source evidence against exact A6.7 frozen submissions, with its indexes, CHECKs,
-- organization/time guard and append-only trigger. No applied migration is modified, no existing table is
-- altered, and the generated statements below were produced schema-to-schema with no unrelated drift.
--
-- A registration is provenance only: it asserts no amount, no payer adjudication, no cash receipt, no claim
-- status and no balance, and it never changes the frozen submission, its A6.8 lifecycle or its A6.9 correction
-- lineage. There is no status, current or latest pointer.

-- CreateTable
CREATE TABLE "revenue_source_evidence" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "claim_submission_id" UUID NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_reference" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "source_digest_sha256" CHAR(64),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_source_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "revenue_source_evidence_organization_id_idx" ON "revenue_source_evidence"("organization_id");

-- CreateIndex
CREATE INDEX "revenue_source_evidence_recorded_by_user_id_idx" ON "revenue_source_evidence"("recorded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_source_evidence_identity_key" ON "revenue_source_evidence"("claim_submission_id", "source_kind", "source_reference", "source_version");

-- AddForeignKey
ALTER TABLE "revenue_source_evidence" ADD CONSTRAINT "revenue_source_evidence_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_source_evidence" ADD CONSTRAINT "revenue_source_evidence_claim_submission_id_fkey" FOREIGN KEY ("claim_submission_id") REFERENCES "claim_freezes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_source_evidence" ADD CONSTRAINT "revenue_source_evidence_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- Hand-written integrity (A7.1 §3, §4) -------------------------------------------------------------

-- §3 — the fixed contract version.
ALTER TABLE "revenue_source_evidence"
  ADD CONSTRAINT "revenue_source_evidence_version_chk" CHECK ("source_version" IS NOT NULL AND "source_version" = 'A7-REVENUE-SOURCE-1');

-- §3/§4 — in A7.1 the only source kind is INTERNAL_SYNTHETIC. EXTERNAL_VERIFIED stays impossible, even by
-- direct SQL, until an A9 owner brings an authenticated connector and an independently checkable artifact
-- (and widens this CHECK in its own migration). Unverified input can never claim payer verification.
ALTER TABLE "revenue_source_evidence"
  ADD CONSTRAINT "revenue_source_evidence_kind_chk" CHECK ("source_kind" IS NOT NULL AND "source_kind" = 'INTERNAL_SYNTHETIC');

-- §3 — an opaque reference: 3 to 64 characters of upper-case letters, digits, '.', '_' and '-', starting with
-- a letter or digit. No lower case, space, '/', ':', '?', '=' or '@', so no URL, token, e-mail, raw payer
-- message or free text fits.
ALTER TABLE "revenue_source_evidence"
  ADD CONSTRAINT "revenue_source_evidence_reference_chk" CHECK ("source_reference" IS NOT NULL AND "source_reference" ~ '^[A-Z0-9][A-Z0-9._-]{2,63}$');

-- §3 — a source digest may only ever be the SHA-256 of retained bytes owned by a trusted source. A7.1 has no
-- such source, so no digest is stored (never fabricated). A later owner widens this CHECK with the source.
ALTER TABLE "revenue_source_evidence"
  ADD CONSTRAINT "revenue_source_evidence_digest_chk" CHECK ("source_digest_sha256" IS NULL);

-- §4 — the database is the backstop behind every service check, so a direct INSERT cannot bypass it. A
-- registration:
-- * is received and created at the database's own transaction time (nothing backdated or postdated);
-- * belongs to exactly the organization that owns its frozen submission (submission -> claim -> encounter ->
--   patient -> organization), so a row can never point at another tenant's freeze or name another tenant.
CREATE OR REPLACE FUNCTION revenue_source_evidence_insert_guard()
RETURNS TRIGGER AS $$
DECLARE
  owning_organization uuid;
BEGIN
  IF NEW."received_at" IS DISTINCT FROM now() OR NEW."created_at" IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'revenue_source_evidence_time: source evidence is received at the database''s own time'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT p."organization_id" INTO owning_organization
  FROM "claim_freezes" f
  JOIN "claims" c ON c."id" = f."claim_id"
  JOIN "encounters" e ON e."id" = c."encounter_id"
  JOIN "patients" p ON p."id" = e."patient_id"
  WHERE f."id" = NEW."claim_submission_id";
  IF owning_organization IS NULL THEN
    RETURN NEW; -- the foreign key reports a missing frozen submission
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM owning_organization THEN
    RAISE EXCEPTION 'revenue_source_evidence_coherence: the organization must be the one that owns the frozen submission'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER revenue_source_evidence_insert_guard_trg
  BEFORE INSERT ON "revenue_source_evidence"
  FOR EACH ROW EXECUTE FUNCTION revenue_source_evidence_insert_guard();

-- §3/§4 — a registration is evidence: never updated (not even a no-op update) and never deleted.
CREATE OR REPLACE FUNCTION revenue_source_evidence_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER revenue_source_evidence_append_only_trg
  BEFORE UPDATE OR DELETE ON "revenue_source_evidence"
  FOR EACH ROW EXECUTE FUNCTION revenue_source_evidence_append_only();

-- There is deliberately no status, verified flag, amount, currency, payer, denial, remittance, external time,
-- current or latest pointer, and no new column on claim_freezes.
