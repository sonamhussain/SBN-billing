-- Fix: the original activated_at CHECK was bidirectional (also required activated_at to be
-- cleared once a version left ACTIVE), which broke superseding a version — activatedAt must
-- survive a SUPERSEDED/RETIRED transition so lifecycle stays reconstructable from timestamps,
-- exactly like RuleSourceVersion's own one-directional activated_at check (REF-01 / R3).
ALTER TABLE "reference_dataset_versions"
DROP CONSTRAINT "reference_dataset_versions_activated_at_chk";

ALTER TABLE "reference_dataset_versions"
ADD CONSTRAINT "reference_dataset_versions_activated_at_chk"
CHECK (activation_status <> 'ACTIVE' OR activated_at IS NOT NULL);
