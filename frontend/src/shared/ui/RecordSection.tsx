import type { ReactNode } from 'react'

// FE-03 — one titled section of a record workspace: a heading, an optional one-line description and
// an optional section-local action. Sections replace a tab per backend module.
export function RecordSection({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  const headingId = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section aria-labelledby={headingId} className="mt-10">
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-lg font-semibold text-slate-950">
            {title}
          </h2>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}
