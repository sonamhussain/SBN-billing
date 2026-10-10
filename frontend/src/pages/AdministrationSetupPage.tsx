import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminSectionNav } from '../features/admin/AdminSectionNav.tsx'
import { ClinicalSetup } from '../features/admin-clinical/ClinicalSetup.tsx'
import { CodingSetup } from '../features/admin-coding/CodingSetup.tsx'
import { ProviderContracts } from '../features/admin-commercial/ProviderContracts.tsx'
import { InsuranceSetup } from '../features/admin-insurance/InsuranceSetup.tsx'
import { OrganizationSettings } from '../features/admin-organization/OrganizationSettings.tsx'
import { PageHeader } from '../shared/layout/PageHeader.tsx'

// FE-05 — Setup: the identities and commercial structures this organization uses for billing. Each group
// loads only when opened. Masters are maintained through their owner routes; nothing here prices, checks
// eligibility or changes billing history.

const groups = [
  { key: 'organization', label: 'Organization' },
  { key: 'clinical', label: 'Clinical' },
  { key: 'insurance', label: 'Insurance' },
  { key: 'coding', label: 'Coding' },
  { key: 'commercial', label: 'Commercial' },
] as const

type GroupKey = (typeof groups)[number]['key']

export default function AdministrationSetupPage() {
  const [group, setGroup] = useState<GroupKey>('organization')

  return (
    <>
      <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
        <Link to="/app/admin" className="inline-flex items-center gap-1.5 hover:text-slate-950">
          <ArrowLeft aria-hidden="true" size={15} /> Administration
        </Link>
      </nav>
      <PageHeader eyebrow="Administration" title="Setup" />
      <AdminSectionNav label="Setup groups" groups={groups} value={group} onChange={setGroup} />
      {group === 'organization' && <OrganizationSettings />}
      {group === 'clinical' && <ClinicalSetup />}
      {group === 'insurance' && <InsuranceSetup />}
      {group === 'coding' && <CodingSetup />}
      {group === 'commercial' && <ProviderContracts />}
    </>
  )
}
