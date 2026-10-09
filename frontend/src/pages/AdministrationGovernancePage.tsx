import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminSectionNav } from '../features/admin/AdminSectionNav.tsx'
import { RulePacks } from '../features/admin-governance/packs/RulePacks.tsx'
import { ReferenceDatasets } from '../features/admin-governance/reference/ReferenceDatasets.tsx'
import { RuleDefinitions } from '../features/admin-governance/rules/RuleDefinitions.tsx'
import { RuleSources } from '../features/admin-governance/sources/RuleSources.tsx'
import { PageHeader } from '../shared/layout/PageHeader.tsx'

// FE-05 — Governance: regulatory/reference data, rule sources, governed rules and rule packs, with their
// history. Advanced relationships, scopes, applicability and bindings are progressively disclosed. Every
// state is the owner's recorded state; nothing here resolves, ranks or executes rules.

const groups = [
  { key: 'reference', label: 'Regulatory / Reference' },
  { key: 'sources', label: 'Sources' },
  { key: 'rules', label: 'Rules' },
  { key: 'packs', label: 'Rule packs' },
] as const

type GroupKey = (typeof groups)[number]['key']

export default function AdministrationGovernancePage() {
  const [group, setGroup] = useState<GroupKey>('sources')

  return (
    <>
      <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
        <Link to="/app/admin" className="inline-flex items-center gap-1.5 hover:text-slate-950">
          <ArrowLeft aria-hidden="true" size={15} /> Administration
        </Link>
      </nav>
      <PageHeader eyebrow="Administration" title="Governance" />
      <AdminSectionNav label="Governance groups" groups={groups} value={group} onChange={setGroup} />
      {group === 'reference' && <ReferenceDatasets />}
      {group === 'sources' && <RuleSources />}
      {group === 'rules' && <RuleDefinitions />}
      {group === 'packs' && <RulePacks />}
    </>
  )
}
