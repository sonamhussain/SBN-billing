-- A5.1 — Evidence Artifact & Evidence Version Foundation.
--
-- Two tables and nothing else: a stable organization-owned evidence identity, and the immutable
-- metadata of each exact representation that was received and stored for it. No file bytes, no
-- document payload, no workflow status, and no reference to a patient, encounter, membership,
-- authorization or claim — those belong to the records that own them.
--
-- Migration Drift Guard: Prisma also generated four Better Auth `ALTER COLUMN id SET DEFAULT`
-- statements and three `DROP INDEX` statements for the hand-written A3 partial unique indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). All seven are unrelated generated churn and were removed.

-- CreateTable
CREATE TABLE "evidence_artifacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence_artifact_versions" (
    "id" UUID NOT NULL,
    "evidence_artifact_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "storage_ref" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "source_date" DATE,
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_artifact_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "evidence_artifacts_organization_id_idx" ON "evidence_artifacts"("organization_id");

-- CreateIndex
CREATE INDEX "evidence_artifact_versions_evidence_artifact_id_idx" ON "evidence_artifact_versions"("evidence_artifact_id");

-- CreateIndex
CREATE INDEX "evidence_artifact_versions_created_by_user_id_idx" ON "evidence_artifact_versions"("created_by_user_id");

-- CreateIndex
CREATE INDEX "evidence_artifact_versions_document_type_idx" ON "evidence_artifact_versions"("document_type");

-- CreateIndex
CREATE INDEX "evidence_artifact_versions_content_hash_idx" ON "evidence_artifact_versions"("content_hash");

-- One version number may exist once per artifact. Combined with server-owned numbering under a row
-- lock, this is what makes the sequence gap-free and unambiguous under concurrent writers. There is
-- deliberately NO unique index on content_hash or storage_ref: the same bytes may legitimately back
-- more than one evidence identity, and storage-provider identity semantics are not frozen here.
-- CreateIndex
CREATE UNIQUE INDEX "evidence_artifact_versions_evidence_artifact_id_version_key" ON "evidence_artifact_versions"("evidence_artifact_id", "version");

-- AddForeignKey
ALTER TABLE "evidence_artifacts" ADD CONSTRAINT "evidence_artifacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_artifact_versions" ADD CONSTRAINT "evidence_artifact_versions_evidence_artifact_id_fkey" FOREIGN KEY ("evidence_artifact_id") REFERENCES "evidence_artifacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence_artifact_versions" ADD CONSTRAINT "evidence_artifact_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Version numbers start at 1 and count upward. A zero or negative version would make "the first
-- representation" ambiguous, so the database refuses one outright.
ALTER TABLE "evidence_artifact_versions"
ADD CONSTRAINT "evidence_artifact_versions_version_positive_chk"
CHECK ("version" >= 1);

-- The three opaque strings must carry something. A blank storage reference names nothing, a blank
-- hash identifies nothing, and a blank document type describes nothing; each would leave a version
-- row that claims to record a representation while recording none of it.
ALTER TABLE "evidence_artifact_versions"
ADD CONSTRAINT "evidence_artifact_versions_storage_ref_nonblank_chk"
CHECK (btrim("storage_ref") <> '');

ALTER TABLE "evidence_artifact_versions"
ADD CONSTRAINT "evidence_artifact_versions_content_hash_nonblank_chk"
CHECK (btrim("content_hash") <> '');

ALTER TABLE "evidence_artifact_versions"
ADD CONSTRAINT "evidence_artifact_versions_document_type_nonblank_chk"
CHECK (btrim("document_type") <> '');

-- Append-only, enforced by the database rather than by convention. There is no update or delete
-- route and no repository function that could write one, but the guarantee an auditor needs is
-- stronger than that: once a version is written it cannot be altered or removed at all, by any
-- caller, including a direct SQL statement. A correction is a NEW version, so the representation a
-- past decision was made against can always be read back exactly as it was.
CREATE OR REPLACE FUNCTION evidence_artifact_versions_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'evidence_artifact_versions is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evidence_artifact_versions_append_only_trg
  BEFORE UPDATE OR DELETE ON "evidence_artifact_versions"
  FOR EACH ROW EXECUTE FUNCTION evidence_artifact_versions_append_only();
