import { useState } from 'react'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { formatInstant } from '../../shared/format/date.ts'
import { Button } from '../../shared/ui/Button.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useAuthorizationVersions, useEncounterAuthorizations } from './authorization.queries.ts'
import type { PriorAuthorization } from './authorization.types.ts'
import { AuthorizationRecordDialog } from './AuthorizationRecordDialog.tsx'
import { AuthorizationVersionDetail } from './AuthorizationVersionDetail.tsx'
import { AuthorizationVersionDialog } from './AuthorizationVersionDialog.tsx'

// FE-04 — Prior authorization: the Encounter's recorded authorization cases. A case shows its "latest
// recorded version" (never current, usable or satisfied); opening it lists every immutable version with
// its line scope. Nothing is requested from or submitted to a payer.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

function AuthorizationCase({ authorization, encounterId, blocked }: { authorization: PriorAuthorization; encounterId: string; blocked: boolean }) {
  const [open, setOpen] = useState(false)
  const versions = useAuthorizationVersions(authorization.id, open)
  const latest = authorization.latestRecordedVersion

  return (
    <li className="rounded-lg border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
        <div className="min-w-0">
          <p className="font-medium text-slate-950">Authorization case · recorded {formatInstant(authorization.createdAt)}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            Latest recorded version {latest.version} · {latest.versionKind} · {latest.status}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PermissionGate permission="priorAuthorizationVersion.create">
            <AuthorizationVersionDialog
              encounterId={encounterId}
              authorizationId={authorization.id}
              trigger={
                <Button className={secondaryButton} disabled={blocked}>
                  Add authorization version
                </Button>
              }
            />
          </PermissionGate>
          <button
            type="button"
            aria-expanded={open}
            className="rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100"
            onClick={() => setOpen(!open)}
          >
            {open ? 'Hide versions' : 'Show versions'}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-slate-200">
          {versions.isPending && <Skeleton className="m-4 h-16" />}
          {versions.isError && <p className="px-4 py-3 text-sm text-red-700">Authorization versions could not be loaded.</p>}
          {versions.data && (
            <ul className="divide-y divide-slate-200">
              {versions.data.map((version) => (
                <AuthorizationVersionDetail key={version.id} version={version} encounterId={encounterId} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export function AuthorizationSection({ encounterId, readable, blocked }: { encounterId: string; readable: boolean; blocked: boolean }) {
  const authorizations = useEncounterAuthorizations(encounterId, readable)

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Prior authorization</h3>
          <p className="mt-0.5 text-xs text-slate-500">Recorded authorization history. Scope matching is shown as evaluated, not as approval.</p>
        </div>
        <PermissionGate permission="priorAuthorization.create">
          <AuthorizationRecordDialog
            encounterId={encounterId}
            trigger={
              <Button className={secondaryButton} disabled={blocked}>
                Record authorization
              </Button>
            }
          />
        </PermissionGate>
      </div>
      {!readable && <EmptyState title="Prior authorization history is not available to you." />}
      {readable && authorizations.isPending && <Skeleton className="h-16 w-full" />}
      {authorizations.isError && !authorizations.data && (
        <p role="alert" className="text-sm text-red-700">
          Prior authorization history could not be loaded.
        </p>
      )}
      {authorizations.data &&
        (authorizations.data.length === 0 ? (
          <EmptyState title="No authorization recorded" />
        ) : (
          <ul className="space-y-3">
            {authorizations.data.map((authorization) => (
              <AuthorizationCase key={authorization.id} authorization={authorization} encounterId={encounterId} blocked={blocked} />
            ))}
          </ul>
        ))}
    </div>
  )
}
