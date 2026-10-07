import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

// Radix owns focus trapping and restoration; no custom focus traps.
// open/onOpenChange are optional: a caller that omits them keeps the uncontrolled behaviour, and a
// caller that must close the surface after a confirmed save (FE-02 forms) controls it.
export function Dialog({
  trigger,
  title,
  children,
  open,
  onOpenChange,
}: {
  trigger: ReactNode
  title: string
  children: ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/30" />
        {/* A form taller than the viewport scrolls inside the dialog instead of being cut off. */}
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100vh-2rem)] w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border bg-white p-6 shadow-xl">
          <div className="flex items-start justify-between gap-4">
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-slate-100">
              <X aria-hidden="true" size={18} />
            </DialogPrimitive.Close>
          </div>
          <div className="mt-4">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
