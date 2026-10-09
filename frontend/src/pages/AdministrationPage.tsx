import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../shared/layout/PageHeader.tsx'

// FE-05 — the Administration landing: two plain choices, Setup and Governance. No counts, charts, health
// scores, organization switcher or Developer Tools link.

const areas = [
  {
    to: '/app/admin/setup',
    title: 'Setup',
    text: 'Organization, clinical masters, payers, coding and commercial structures.',
  },
  {
    to: '/app/admin/governance',
    title: 'Governance',
    text: 'Regulatory and reference data, rule sources, governed rules and rule packs.',
  },
]

export default function AdministrationPage() {
  return (
    <>
      <PageHeader eyebrow="Administration" title="Administration" />
      <p className="-mt-3 mb-6 text-sm text-slate-500">Configure the organization without changing billing history.</p>
      <div className="grid gap-4 md:grid-cols-2">
        {areas.map((area) => (
          <Link
            key={area.to}
            to={area.to}
            className="group flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-white p-5 hover:border-slate-300 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{area.title}</h2>
              <p className="mt-1 text-sm text-slate-500">{area.text}</p>
            </div>
            <ChevronRight aria-hidden="true" size={18} className="mt-1 shrink-0 text-slate-400 group-hover:text-slate-600" />
          </Link>
        ))}
      </div>
    </>
  )
}
