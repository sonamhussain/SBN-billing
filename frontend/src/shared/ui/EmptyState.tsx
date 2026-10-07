import type { ReactNode } from 'react'

// FE-03 — a calm statement that a section holds no recorded rows (or is not available), never a
// loading or error state.
export function EmptyState({ title, message, action }: { title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-5 text-sm">
      <p className="font-medium text-slate-700">{title}</p>
      {message && <p className="mt-1 text-slate-500">{message}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}
