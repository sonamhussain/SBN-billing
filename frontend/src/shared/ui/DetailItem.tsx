import type { ReactNode } from 'react'

// One labelled value in a record panel: a small label above its value. A missing value is shown as
// "Not recorded" rather than left blank, so an empty field is never mistaken for a loading one.
export function DetailItem({ label, value }: { label: string; value: ReactNode }) {
  const empty = value === null || value === undefined || value === ''
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={empty ? 'mt-1 text-sm text-slate-400' : 'mt-1 break-words text-sm font-medium text-slate-950'}>
        {empty ? 'Not recorded' : value}
      </dd>
    </div>
  )
}
