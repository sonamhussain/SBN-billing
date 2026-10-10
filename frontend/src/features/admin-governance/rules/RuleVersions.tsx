import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiRequest } from '../../../shared/api/client.ts'
import { PermissionGate } from '../../../shared/auth/PermissionGate.tsx'
import { formatDateOnly, formatInstant } from '../../../shared/format/date.ts'
import { Button } from '../../../shared/ui/Button.tsx'
import { EmptyState } from '../../../shared/ui/EmptyState.tsx'
import { Field } from '../../../shared/ui/Field.tsx'
import { OutcomeBadge } from '../../../shared/ui/OutcomeBadge.tsx'
import { Select } from '../../../shared/ui/Select.tsx'
import { Skeleton } from '../../../shared/ui/Skeleton.tsx'
import { ConfirmAction } from '../../admin/ConfirmAction.tsx'
import { MasterFormDialog } from '../../admin/MasterFormDialog.tsx'
import { ownerKey, useOwnerItems, useOwnerRecord } from '../../admin/owner-query.ts'
import { GovernedDimensions } from '../GovernedDimensions.tsx'
import { ruleEffectTypes } from './rule-vocabulary.ts'

// FE-05 — a rule definition's versions (A3.5): version, owner-defined effect type, recorded effective period
// and verification, exactly as stored. Metadata edits and verification go through the owner routes; there
// is no rule-expression editor. Applicability and source bindings (A3.6/A3.7) are advanced, read-only
// detail. Evaluations that need a facility context are not offered: no complete facility chooser exists.


type RuleVersion = {
  id: string
  ruleId: string
  version: string
  effectType: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
}
type Applicability = { id: string } & Record<string, unknown>
type Binding = { id: string; sourceInterpretationId: string; sourceRole: string }

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
const linkButton = 'rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100'
const verificationChoices = ['IN_REVIEW', 'VERIFIED', 'REJECTED'] as const
// A period with neither end recorded reads as one "Not recorded" rather than two placeholders.
const period = (from: string | null, to: string | null) =>
  !from && !to ? 'Not recorded' : `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function InterpretationLabel({ id }: { id: string }) {
  const interpretation = useOwnerRecord<{ interpretationVersion: string; verificationStatus: string }>(`/api/source-interpretations/${id}`, 'source_interpretation.read')
  if (!interpretation.permitted || interpretation.isError) return <>Unavailable</>
  return <>{interpretation.data ? `interpretation ${interpretation.data.interpretationVersion} · ${interpretation.data.verificationStatus}` : 'Loading...'}</>
}

function VersionAdvanced({ versionId }: { versionId: string }) {
  const applicabilities = useOwnerItems<Applicability>(`/api/rule-versions/${versionId}/applicabilities`, 'rule_applicability.read')
  const bindings = useOwnerItems<Binding>(`/api/rule-versions/${versionId}/source-bindings`, 'rule_source_binding.read')
  return (
    <div className="space-y-3 text-xs">
      <div>
        <h6 className="font-medium text-slate-500">Applicability</h6>
        {!applicabilities.permitted && <p className="text-slate-500">Not available to you.</p>}
        {applicabilities.isError && <p className="text-red-700">Could not be loaded.</p>}
        {applicabilities.data &&
          (applicabilities.data.length === 0 ? (
            <p className="text-slate-500">None recorded.</p>
          ) : (
            <ul className="space-y-2">
              {applicabilities.data.map((item) => (
                <li key={item.id} className="rounded-md border border-slate-200 bg-white p-2">
                  <GovernedDimensions record={item} />
                </li>
              ))}
            </ul>
          ))}
      </div>
      <div>
        <h6 className="font-medium text-slate-500">Source bindings</h6>
        {!bindings.permitted && <p className="text-slate-500">Not available to you.</p>}
        {bindings.isError && <p className="text-red-700">Could not be loaded.</p>}
        {bindings.data &&
          (bindings.data.length === 0 ? (
            <p className="text-slate-500">None recorded.</p>
          ) : (
            <ul className="space-y-0.5 text-slate-700">
              {bindings.data.map((item) => (
                <li key={item.id}>
                  {item.sourceRole} · <InterpretationLabel id={item.sourceInterpretationId} />
                </li>
              ))}
            </ul>
          ))}
      </div>
      <p className="text-slate-500">
        Applicability, executability and resolution evaluations need a facility context and are available once a complete facility chooser exists.
      </p>
    </div>
  )
}

function VerificationAction({ version, onDone }: { version: RuleVersion; onDone: () => Promise<unknown> }) {
  const [status, setStatus] = useState<(typeof verificationChoices)[number]>('IN_REVIEW')
  return (
    <ConfirmAction
      trigger={
        <button type="button" className={linkButton}>
          Record verification
        </button>
      }
      title={`Record verification for version ${version.version}`}
      description="Records the verification outcome of this rule version. The owner decides whether the change is allowed in the version's current state."
      confirmLabel="Record verification"
      subject="Rule verification"
      onConfirm={async () => {
        await apiRequest(`/api/rule-versions/${version.id}/verification`, { method: 'POST', body: JSON.stringify({ verificationStatus: status }) })
        await onDone()
      }}
    >
      <Field label="Verification status">
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {verificationChoices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </Select>
      </Field>
    </ConfirmAction>
  )
}

function VersionRow({ version, writable, refresh }: { version: RuleVersion; writable: boolean; refresh: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-950">Version {version.version}</span>
        <span className="font-mono text-xs text-slate-600">{version.effectType}</span>
        <OutcomeBadge value={version.verificationStatus} />
        <button type="button" aria-expanded={open} className={`ml-auto ${linkButton}`} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Details'}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Effective {period(version.effectiveFrom, version.effectiveTo)}
        {version.verifiedAt ? ` · verified ${formatInstant(version.verifiedAt)}` : ''}
      </p>
      {open && (
        <div className="space-y-3 rounded-md bg-slate-50 p-3">
          {writable && (
            <div className="flex flex-wrap gap-1">
              <PermissionGate permission="rule_version.update">
                <MasterFormDialog
                  title={`Edit version ${version.version}`}
                  subject="Rule version"
                  fields={[
                    { key: 'effectType', label: 'Effect type', required: true, options: ruleEffectTypes },
                    { key: 'effectiveFrom', label: 'Effective from', type: 'date' },
                    { key: 'effectiveTo', label: 'Effective to', type: 'date' },
                  ]}
                  record={version}
                  trigger={
                    <button type="button" className={linkButton}>
                      Edit metadata
                    </button>
                  }
                  onSubmit={async (patch) => {
                    await apiRequest(`/api/rule-versions/${version.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
                    await refresh()
                  }}
                />
              </PermissionGate>
              <PermissionGate permission="rule_version.verify">
                <VerificationAction version={version} onDone={refresh} />
              </PermissionGate>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-sm text-[var(--sbn-accent)]">Applicability and source bindings (advanced, read-only)</summary>
            <div className="mt-2">
              <VersionAdvanced versionId={version.id} />
            </div>
          </details>
        </div>
      )}
    </li>
  )
}

export function RuleVersions({ ruleId, writable }: { ruleId: string; writable: boolean }) {
  const path = `/api/rule-definitions/${ruleId}/versions`
  const versions = useOwnerItems<RuleVersion>(path, 'rule_version.read')
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: ownerKey(path) })

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-950">Versions</h3>
        {writable && (
          <PermissionGate permission="rule_version.create">
            <MasterFormDialog
              title="New rule version"
              subject="Rule version"
              fields={[
                { key: 'version', label: 'Version', required: true },
                { key: 'effectType', label: 'Effect type', required: true, options: ruleEffectTypes },
                { key: 'effectiveFrom', label: 'Effective from', type: 'date' },
                { key: 'effectiveTo', label: 'Effective to', type: 'date' },
              ]}
              trigger={<Button className={secondaryButton}>New version</Button>}
              onSubmit={async (body) => {
                await apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
                await refresh()
              }}
            />
          </PermissionGate>
        )}
      </div>
      {!versions.permitted && <EmptyState title="Rule versions are not available to you." />}
      {versions.permitted && versions.isPending && <Skeleton className="h-16 w-full" />}
      {versions.isError && <p className="text-sm text-red-700">Rule versions could not be loaded.</p>}
      {versions.data &&
        (versions.data.length === 0 ? (
          <EmptyState title="No version recorded for this rule" />
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {versions.data.map((version) => (
              <VersionRow key={version.id} version={version} writable={writable} refresh={refresh} />
            ))}
          </ul>
        ))}
    </section>
  )
}
