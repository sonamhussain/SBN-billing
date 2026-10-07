import type { ReactNode } from 'react'

// A visible label wrapping its control, so every form input is labeled for screen readers and keyboard
// users without placeholder-only labelling.
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      {hint && <span className="ml-1 text-slate-500">{hint}</span>}
      <div className="mt-1">{children}</div>
    </label>
  )
}
