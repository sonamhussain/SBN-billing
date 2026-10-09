import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { apiRequest } from '../../shared/api/client.ts'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import type { Organization } from '../../shared/organization/organization.api.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'

// FE-05 — the current, server-validated organization: its name, editable with organization.update. There is
// no organization creation or switching here. Facilities and user/role administration are controlled gaps:
// the backend has no complete Facility collection and no member/role management contract, so nothing is
// assembled or invented in their place.

function RenameOrganization() {
  const { organizationId, organizationName } = useOrganization()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(organizationName)
  const rename = useMutation({
    mutationFn: (next: string) => apiRequest<Organization>(`/api/organizations/${organizationId}`, { method: 'PATCH', body: JSON.stringify({ name: next }) }),
    // The provider's organization query is the one source of the name shown in the shell; it is updated
    // from the server's confirmed answer.
    onSuccess: (organization) => client.setQueryData(['organization', organizationId], organization),
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    setName(organizationName)
    rename.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await rename.mutateAsync(name)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state.
    }
  }

  return (
    <Dialog
      title="Edit organization"
      open={open}
      onOpenChange={onOpenChange}
      trigger={<Button className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50">Edit name</Button>}
    >
      <form className="space-y-3" onSubmit={submit}>
        {rename.isError && <Alert tone="danger">{describeSaveError(rename.error, 'Organization')}</Alert>}
        <Field label="Organization name">
          <Input required autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={rename.isPending || name.trim() === '' || name === organizationName}>
            {rename.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function OrganizationSettings() {
  const { organizationName, permissions } = useOrganization()

  return (
    <div className="space-y-6">
      <section aria-label="Organization" className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex items-start justify-between gap-4">
          <dl>
            <DetailItem label="Organization name" value={organizationName} />
          </dl>
          <PermissionGate permission="organization.update">
            <RenameOrganization />
          </PermissionGate>
        </div>
      </section>

      <section aria-label="Facilities" className="space-y-2">
        <h3 className="text-base font-semibold text-slate-950">Facilities</h3>
        <EmptyState
          title="Facility administration is not available yet"
          message="Facility administration requires a complete facility collection contract, which the backend does not provide yet. Facilities appear where a record already names them, for example in a clinician's recorded assignments."
        />
      </section>

      <section aria-label="Users and access" className="space-y-2">
        <h3 className="text-base font-semibold text-slate-950">Users and access</h3>
        <EmptyState
          title="User and role administration is not available yet"
          message="Members and roles are provisioned outside the product until a member management contract exists. Your own effective permissions in this organization are listed below."
        />
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--sbn-accent)]">Your effective permissions ({permissions.length})</summary>
          <ul className="mt-2 grid gap-x-6 gap-y-0.5 font-mono text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-3">
            {[...permissions].sort().map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </details>
      </section>
    </div>
  )
}
