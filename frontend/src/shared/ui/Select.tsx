import type { SelectHTMLAttributes } from 'react'
import { cn } from '../cn.ts'

// A native select styled like Input, so options stay keyboard- and screen-reader-accessible.
export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none',
        'focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400',
        className,
      )}
      {...props}
    />
  )
}
