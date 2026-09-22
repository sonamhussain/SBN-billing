-- A4.1 — Patient identity and minimum demographics.
--
-- Migration Drift Guard applied: Prisma's generated draft also contained four
-- "ALTER COLUMN id SET DEFAULT" statements for the Better Auth tables and three spurious
-- "DROP INDEX" statements for the hand-written indexes
-- (rule_applicabilities_exact_scope_uq, rule_packs_scope_pack_key_uq,
-- rule_source_scopes_exact_scope_uq). Those objects are deliberate and are NOT dropped or
-- redefined here. This migration creates the patients table and nothing else; no A1–A3 table is
-- altered and no applied migration is rewritten.

-- CreateTable
CREATE TABLE "patients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "given_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "family_name" TEXT NOT NULL,
    -- A calendar date, never a timestamp.
    "date_of_birth" DATE NOT NULL,
    "mobile_phone" TEXT,
    "email" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patients_organization_id_idx" ON "patients"("organization_id");

-- AddForeignKey: deleting an Organization must never silently erase patient history.
ALTER TABLE "patients" ADD CONSTRAINT "patients_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written CHECKs: a required name may not be blank or whitespace only, and an optional
-- middle name is either absent or a real value. There is deliberately NO uniqueness on
-- demographics: two different people may share a name and a date of birth, and duplicate
-- registration cannot be resolved safely by a database constraint.
ALTER TABLE "patients"
  ADD CONSTRAINT "patients_given_name_not_blank_chk" CHECK (btrim("given_name") <> '');

ALTER TABLE "patients"
  ADD CONSTRAINT "patients_family_name_not_blank_chk" CHECK (btrim("family_name") <> '');

ALTER TABLE "patients"
  ADD CONSTRAINT "patients_middle_name_not_blank_chk" CHECK ("middle_name" IS NULL OR btrim("middle_name") <> '');

-- A future date of birth is refused by application validation, not by a CHECK: CURRENT_DATE is
-- volatile, so a row that was valid when written must not become invalid as the clock moves.
