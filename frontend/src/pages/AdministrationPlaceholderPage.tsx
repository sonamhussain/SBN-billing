import { PageHeader } from '../shared/layout/PageHeader.tsx'

// Title only until a later FE module connects real administration: no fake records or settings.
export default function AdministrationPlaceholderPage() {
  return <PageHeader eyebrow="SBN Billing" title="Administration" />
}
