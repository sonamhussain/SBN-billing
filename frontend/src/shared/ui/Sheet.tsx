import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'

// A right-hand side panel built on the Radix dialog; Radix owns focus behavior.
// open/onOpenChange are optional: a caller that omits them keeps the uncontrolled behaviour, and a
// caller that must close the surface after a confirmed save (FE-02 forms) controls it.
export function Sheet({
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/20" />
        <DialogPrimitive.Content className="fixed inset-y-0 right-0 z-50 w-[min(34rem,100vw)] overflow-y-auto border-l bg-white p-6 shadow-xl">
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
