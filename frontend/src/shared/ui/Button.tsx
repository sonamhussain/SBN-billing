import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../cn.ts'

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex min-h-10 items-center justify-center rounded-md bg-[var(--sbn-accent)] px-4 text-sm font-medium text-white',
        'hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
