import type { ReactNode } from 'react'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Button } from '../../shared/ui/Button.tsx'
import { LoadedList } from './LoadedList.tsx'
import { MasterFormDialog, type MasterField } from './MasterFormDialog.tsx'
import { useMasterList, useMasterMutations, type MasterOwner } from './master-api.ts'

// FE-05 — one organization master as a section: its loaded list, a Create action with the exact
// <owner>.create permission and an Edit action per row with <owner>.update. There is no delete: the master
// owners do not offer one. Rows may open an owner detail through `detail`.

export type MasterRecord = { id: string } & Record<string, unknown>

// "Clinician" reads as "clinician" inside a sentence; an acronym such as "TPA" stays as written.
const inSentence = (subject: string) => (subject === subject.toUpperCase() ? subject : subject.toLowerCase())

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
const linkButton = 'rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100'

export function SimpleMasterSection<T extends MasterRecord>({
  title,
  noun,
  subject,
  owner,
  fields,
  primary,
  secondary,
  detail,
  editFields,
  editable,
  badge,
}: {
  title: string
  // Plural, e.g. "clinicians".
  noun: string
  // Singular, e.g. "Clinician".
  subject: string
  owner: MasterOwner
  fields: MasterField[]
  primary: (item: T) => string
  secondary?: (item: T) => string | null
  // Optional owner detail opened from the row (for example a Clinician's recorded assignments).
  detail?: (item: T) => ReactNode
  // The fields the owner's PATCH accepts when they differ from the create fields.
  editFields?: MasterField[]
  // Whether this row may be edited here at all (for example not a system-shared governed record).
  editable?: (item: T) => boolean
  // A short marker shown with the row, such as "System".
  badge?: (item: T) => ReactNode
}) {
  const { organizationId } = useOrganization()
  const list = useMasterList<T>(owner, organizationId)
  const { create, update } = useMasterMutations<T>(owner, organizationId)

  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-base font-semibold text-slate-950">{title}</h3>
        <PermissionGate permission={owner.create}>
          <MasterFormDialog
            title={`New ${inSentence(subject)}`}
            subject={subject}
            fields={fields}
            trigger={<Button className={secondaryButton}>New {inSentence(subject)}</Button>}
            onSubmit={(body) => create.mutateAsync(body)}
          />
        </PermissionGate>
      </div>
      <LoadedList
        noun={noun}
        query={list}
        rowKey={(item) => item.id}
        filterText={(item) => `${primary(item)} ${secondary?.(item) ?? ''}`}
        emptyTitle={`No ${noun} recorded`}
        renderRow={(item) => (
          <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium text-slate-950">
                <span className="truncate">{primary(item)}</span>
                {badge?.(item)}
              </p>
              {secondary?.(item) && <p className="truncate text-xs text-slate-500">{secondary(item)}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {detail?.(item)}
              {(editable?.(item) ?? true) && (
                <PermissionGate permission={owner.update}>
                  <MasterFormDialog
                    title={`Edit ${inSentence(subject)}`}
                    subject={subject}
                    fields={editFields ?? fields}
                    record={item}
                    trigger={
                      <button type="button" className={linkButton}>
                        Edit
                      </button>
                    }
                    onSubmit={(patch) => update.mutateAsync({ id: item.id, patch })}
                  />
                </PermissionGate>
              )}
            </div>
          </div>
        )}
      />
    </section>
  )
}
