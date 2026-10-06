import type { ReactNode } from 'react'

export function PageHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow?: string
  title: string
  action?: ReactNode
}) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div>
        {eyebrow && <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{eyebrow}</p>}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">{title}</h1>
      </div>
      {action}
    </header>
  )
}
