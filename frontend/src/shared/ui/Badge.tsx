import type { ReactNode } from 'react'
import { cn } from '../cn.ts'

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'attention' | 'danger'
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700',
    success: 'bg-emerald-50 text-emerald-800',
    attention: 'bg-amber-50 text-amber-800',
    danger: 'bg-red-50 text-red-800',
  }
  return <span className={cn('inline-flex rounded-full px-2.5 py-1 text-xs font-medium', tones[tone])}>{children}</span>
}
