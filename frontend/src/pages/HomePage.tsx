import { PageHeader } from '../shared/layout/PageHeader.tsx'

export default function HomePage() {
  return (
    <>
      <PageHeader eyebrow="SBN Billing" title="Home" />
      <section className="max-w-2xl border-t border-slate-200 pt-5">
        <h2 className="text-base font-medium">Continue your work</h2>
        <p className="mt-2 text-sm text-slate-600">
          Patient and encounter workspaces will appear here as their real backend-connected frontend modules are enabled.
        </p>
      </section>
    </>
  )
}
