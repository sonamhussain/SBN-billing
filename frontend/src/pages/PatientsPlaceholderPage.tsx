import { PageHeader } from '../shared/layout/PageHeader.tsx'

// Title only until FE-02 connects the real Patient workspace: no fake records, counts or buttons.
export default function PatientsPlaceholderPage() {
  return <PageHeader eyebrow="SBN Billing" title="Patients" />
}
