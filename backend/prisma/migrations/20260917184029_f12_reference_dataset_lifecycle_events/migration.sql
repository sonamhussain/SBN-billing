-- Audit F12 — a narrowly scoped, append-only lifecycle history for the reference dataset registry.
--
-- Keeping every dataset VERSION is not the same as keeping every TRANSITION. A rollback
-- (v1 -> v2 -> v1 -> v2) re-activates a previously superseded row and overwrites its activated_at
-- and superseded_at, so the sequence cannot be reconstructed from one current state and one
-- timestamp per transition type. Datasets are SYSTEM_SHARED and carry no organizationId, so they
-- can never be forced into the tenant AuditEvent table and no organizationId is invented here.
--
-- Scope is deliberately bounded: this records successful validate/activate/supersede/retire/
-- rollback transitions of reference dataset versions and nothing else. It is not a new universal
-- audit framework, a RuleDecision table or a workflow engine. Nothing is backfilled: transitions
-- that happened before this migration have no evidence, and no event or timestamp is invented for
-- them. History therefore starts here, and a reader can tell the difference.
--
-- Migration Drift Guard applied to the generated SQL: the four recurring auth-table
-- "ALTER COLUMN id SET DEFAULT" lines and the two spurious DROP INDEX statements for the
-- hand-written NULLS NOT DISTINCT indexes (rule_applicabilities_exact_scope_uq,
-- rule_source_scopes_exact_scope_uq — Prisma's DSL cannot represent them) were removed. The
-- partial unique index reference_dataset_versions_one_active_uq added by F11 is hand-written too
-- and must be preserved the same way.

-- CreateTable
CREATE TABLE "reference_dataset_lifecycle_events" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "dataset_id" UUID NOT NULL,
    "dataset_version_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "previous_activation_status" TEXT NOT NULL,
    "next_activation_status" TEXT NOT NULL,
    "previous_validation_status" TEXT NOT NULL,
    "next_validation_status" TEXT NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reference_dataset_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reference_dataset_lifecycle_events_dataset_id_sequence_idx" ON "reference_dataset_lifecycle_events"("dataset_id", "sequence");

-- CreateIndex
CREATE INDEX "reference_dataset_lifecycle_events_dataset_version_id_seque_idx" ON "reference_dataset_lifecycle_events"("dataset_version_id", "sequence");

-- AddForeignKey
ALTER TABLE "reference_dataset_lifecycle_events" ADD CONSTRAINT "reference_dataset_lifecycle_events_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "reference_datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reference_dataset_lifecycle_events" ADD CONSTRAINT "reference_dataset_lifecycle_events_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "reference_dataset_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only, enforced by the database rather than by convention. The maintenance service only
-- ever inserts, and there is no update or delete repository function, but the guarantee an
-- auditor needs is that a row cannot be altered at all once written.
CREATE OR REPLACE FUNCTION reference_dataset_lifecycle_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'reference_dataset_lifecycle_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reference_dataset_lifecycle_events_append_only_trg
  BEFORE UPDATE OR DELETE ON "reference_dataset_lifecycle_events"
  FOR EACH ROW EXECUTE FUNCTION reference_dataset_lifecycle_events_append_only();
