import { PageHeader } from '../shared/layout/PageHeader.tsx'

// Title only until a later FE module connects the real Encounter workspace: no fake records or outcomes.
export default function EncountersPlaceholderPage() {
  return <PageHeader eyebrow="SBN Billing" title="Encounters" />
}
