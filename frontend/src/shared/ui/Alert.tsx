import type { ReactNode } from 'react'
import { cn } from '../cn.ts'

export function Alert({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'danger'
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        tone === 'danger' ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-slate-50 text-slate-700',
      )}
    >
      {children}
    </div>
  )
}
