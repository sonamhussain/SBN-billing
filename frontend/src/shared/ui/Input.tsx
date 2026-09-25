import type { InputHTMLAttributes } from 'react'
import { cn } from '../cn.ts'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'min-h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none',
        'placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100',
        className,
      )}
      {...props}
    />
  )
}
