import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiRequest } from '../../../shared/api/client.ts'
import { describeApiFailure } from '../../../shared/api/error-message.ts'
import { PermissionGate } from '../../../shared/auth/PermissionGate.tsx'
import { formatDateOnly, formatInstant } from '../../../shared/format/date.ts'
import { Alert } from '../../../shared/ui/Alert.tsx'
import { Button } from '../../../shared/ui/Button.tsx'
import { EmptyState } from '../../../shared/ui/EmptyState.tsx'
import { Field } from '../../../shared/ui/Field.tsx'
import { Input } from '../../../shared/ui/Input.tsx'
import { OutcomeBadge } from '../../../shared/ui/OutcomeBadge.tsx'
import { Select } from '../../../shared/ui/Select.tsx'
import { Skeleton } from '../../../shared/ui/Skeleton.tsx'
import { ConfirmAction } from '../../admin/ConfirmAction.tsx'
import { MasterFormDialog } from '../../admin/MasterFormDialog.tsx'
import { ownerKey, useOwnerItems, useOwnerRecord } from '../../admin/owner-query.ts'

// FE-05 — a rule source's versions (A3.2/A3.3) with their recorded publication, verification and activation
// states, exactly as stored. Lifecycle actions (publish, verification, evaluate activation, activate,
// suspend, resume, retire) are explicit owner routes behind a confirmation: the backend decides whether an
// action is allowed in the version's state, and its refusal is shown. Nothing here computes which version is
// current. Interpretations and relationships are advanced, read-only detail.

export type SourceVersion = {
  id: string
  sourceId: string
  version: string
  rawEvidenceRef: string
  publicationStatus: string
  publicationDate: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  activationStatus: string
  activationBlockers: string[]
  activatedAt: string | null
  suspendedAt: string | null
  supersededAt: string | null
  retiredAt: string | null
}
type Interpretation = { id: string; interpretationVersion: string; normalizedInterpretationRef: string; verificationStatus: string }
type Relationship = { id: string; fromSourceVersionId: string; toSourceVersionId: string; relationshipType: string; direction: 'incoming' | 'outgoing' }

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
const linkButton = 'rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100'
const verificationChoices = ['IN_REVIEW', 'VERIFIED', 'REJECTED'] as const
const today = () => new Date().toISOString().slice(0, 10)
// A period with neither end recorded reads as one "Not recorded" rather than two placeholders.
const period = (from: string | null, to: string | null) =>
  !from && !to ? 'Not recorded' : `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function OtherVersionLabel({ versionId }: { versionId: string }) {
  const version = useOwnerRecord<SourceVersion>(`/api/rule-source-versions/${versionId}`, 'rule_source_version.read')
  if (!version.permitted || version.isError) return <>Unavailable</>
  return <>{version.data ? `version ${version.data.version}` : 'Loading...'}</>
}

function VersionAdvanced({ version }: { version: SourceVersion }) {
  const interpretations = useOwnerItems<Interpretation>(`/api/rule-source-versions/${version.id}/interpretations`, 'source_interpretation.read')
  const relationships = useOwnerItems<Relationship>(`/api/rule-source-versions/${version.id}/relationships`, 'rule_source_relationship.read')
  return (
    <div className="space-y-3 text-xs">
      <div>
        <h6 className="font-medium text-slate-500">Interpretations</h6>
        {!interpretations.permitted && <p className="text-slate-500">Not available to you.</p>}
        {interpretations.isError && <p className="text-red-700">Could not be loaded.</p>}
        {interpretations.data &&
          (interpretations.data.length === 0 ? (
            <p className="text-slate-500">None recorded.</p>
          ) : (
            <ul className="space-y-0.5 text-slate-700">
              {interpretations.data.map((item) => (
                <li key={item.id}>
                  {item.interpretationVersion} · {item.verificationStatus} · <span className="break-all font-mono">{item.normalizedInterpretationRef}</span>
                </li>
              ))}
            </ul>
          ))}
      </div>
      <div>
        <h6 className="font-medium text-slate-500">Relationships</h6>
        {!relationships.permitted && <p className="text-slate-500">Not available to you.</p>}
        {relationships.isError && <p className="text-red-700">Could not be loaded.</p>}
        {relationships.data &&
          (relationships.data.length === 0 ? (
            <p className="text-slate-500">None recorded.</p>
          ) : (
            <ul className="space-y-0.5 text-slate-700">
              {relationships.data.map((item) => (
                <li key={item.id}>
                  {item.direction === 'outgoing' ? (
                    <>
                      This version {item.relationshipType} <OtherVersionLabel versionId={item.toSourceVersionId} />
                    </>
                  ) : (
                    <>
                      <OtherVersionLabel versionId={item.fromSourceVersionId} /> {item.relationshipType} this version
                    </>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  )
}

// One lifecycle action through its owner route. `context` asks for the business date and jurisdiction the
// owner requires (activation, resume); they are prefilled for convenience and sent as entered.
function LifecycleAction({
  label,
  description,
  path,
  context,
  jurisdictionCode,
  onDone,
}: {
  label: string
  description: string
  path: string
  context?: boolean
  jurisdictionCode: string
  onDone: () => Promise<unknown>
}) {
  const [businessDate, setBusinessDate] = useState(today())
  const [jurisdiction, setJurisdiction] = useState(jurisdictionCode)
  return (
    <ConfirmAction
      trigger={
        <button type="button" className={linkButton}>
          {label}
        </button>
      }
      title={label}
      description={description}
      confirmLabel={label}
      subject="Source version"
      onConfirm={async () => {
        await apiRequest(path, { method: 'POST', body: JSON.stringify(context ? { businessDate, jurisdictionCode: jurisdiction } : {}) })
        await onDone()
      }}
    >
      {context && (
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Business date">
            <Input type="date" required value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
          </Field>
          <Field label="Jurisdiction code">
            <Input required autoComplete="off" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
          </Field>
        </div>
      )}
    </ConfirmAction>
  )
}

function ActivationCheck({ version, jurisdictionCode }: { version: SourceVersion; jurisdictionCode: string }) {
  const [businessDate, setBusinessDate] = useState(today())
  const [jurisdiction, setJurisdiction] = useState(jurisdictionCode)
  const evaluate = useMutation({
    mutationFn: () =>
      apiRequest<{ blockers: string[] }>(`/api/rule-source-versions/${version.id}/activation/evaluate`, {
        method: 'POST',
        body: JSON.stringify({ businessDate, jurisdictionCode: jurisdiction }),
      }),
  })
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-[var(--sbn-accent)]">Evaluate activation (read-only)</summary>
      <div className="mt-2 space-y-2">
        <div className="grid items-end gap-3 sm:grid-cols-3">
          <Field label="Business date">
            <Input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
          </Field>
          <Field label="Jurisdiction code">
            <Input autoComplete="off" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} />
          </Field>
          <Button type="button" className={secondaryButton} disabled={evaluate.isPending} onClick={() => evaluate.mutate()}>
            {evaluate.isPending ? 'Evaluating...' : 'Evaluate'}
          </Button>
        </div>
        {evaluate.isError && <Alert tone="danger">{describeApiFailure(evaluate.error, 'Activation evaluation')}</Alert>}
        {evaluate.data &&
          (evaluate.data.blockers.length === 0 ? (
            <p className="text-xs text-slate-600">The owner reported no activation blocker for this date and jurisdiction. Nothing was changed.</p>
          ) : (
            <ul className="list-inside list-disc text-xs text-slate-700">
              {evaluate.data.blockers.map((blocker) => (
                <li key={blocker} className="font-mono">
                  {blocker}
                </li>
              ))}
            </ul>
          ))}
      </div>
    </details>
  )
}

function VersionRow({
  version,
  jurisdictionCode,
  writable,
  refresh,
}: {
  version: SourceVersion
  jurisdictionCode: string
  // False for a system-shared source: its lifecycle is not managed from an organization.
  writable: boolean
  refresh: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const base = `/api/rule-source-versions/${version.id}`
  return (
    <li className="space-y-2 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-950">Version {version.version}</span>
        <OutcomeBadge value={version.publicationStatus} />
        <OutcomeBadge value={version.verificationStatus} />
        <OutcomeBadge value={version.activationStatus} />
        <button type="button" aria-expanded={open} className={`ml-auto ${linkButton}`} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Details'}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Effective {period(version.effectiveFrom, version.effectiveTo)} · published {formatDateOnly(version.publicationDate)}
        {version.verifiedAt ? ` · verified ${formatInstant(version.verifiedAt)}` : ''}
        {version.activatedAt ? ` · activated ${formatInstant(version.activatedAt)}` : ''}
      </p>
      {version.activationBlockers.length > 0 && (
        <p className="text-xs text-slate-600">
          Recorded blockers: <span className="font-mono">{version.activationBlockers.join(', ')}</span>
        </p>
      )}
      {open && (
        <div className="space-y-3 rounded-md bg-slate-50 p-3">
          <p className="break-all text-xs text-slate-600">
            Evidence reference: <span className="font-mono">{version.rawEvidenceRef}</span>
          </p>
          {writable && (
          <PermissionGate permission="rule_source_version.lifecycle">
            <div className="flex flex-wrap gap-1">
              <MasterFormDialog
                title={`Edit dates of version ${version.version}`}
                subject="Source version"
                fields={[
                  { key: 'publicationDate', label: 'Publication date', type: 'date' },
                  { key: 'effectiveFrom', label: 'Effective from', type: 'date' },
                  { key: 'effectiveTo', label: 'Effective to', type: 'date' },
                ]}
                record={version}
                trigger={
                  <button type="button" className={linkButton}>
                    Edit dates
                  </button>
                }
                onSubmit={async (patch) => {
                  await apiRequest(`${base}/lifecycle`, { method: 'PATCH', body: JSON.stringify(patch) })
                  await refresh()
                }}
              />
              <LifecycleAction label="Publish" description="Records this version as published. The owner refuses it if the version cannot be published." path={`${base}/publish`} jurisdictionCode={jurisdictionCode} onDone={refresh} />
              <VerificationAction version={version} onDone={refresh} />
              <LifecycleAction
                label="Activate"
                description="Asks the owner to activate this version for the given business date and jurisdiction. The owner checks every activation rule and refuses with its blockers if they are not met."
                path={`${base}/activate`}
                context
                jurisdictionCode={jurisdictionCode}
                onDone={refresh}
              />
              <LifecycleAction label="Suspend" description="Suspends this version. Its history is kept." path={`${base}/suspend`} jurisdictionCode={jurisdictionCode} onDone={refresh} />
              <LifecycleAction label="Resume" description="Asks the owner to resume this suspended version for the given business date and jurisdiction." path={`${base}/resume`} context jurisdictionCode={jurisdictionCode} onDone={refresh} />
              <LifecycleAction label="Retire" description="Retires this version. Retirement is recorded as history and is not undone here." path={`${base}/retire`} jurisdictionCode={jurisdictionCode} onDone={refresh} />
            </div>
          </PermissionGate>
          )}
          <ActivationCheck version={version} jurisdictionCode={jurisdictionCode} />
          <details>
            <summary className="cursor-pointer text-sm text-[var(--sbn-accent)]">Interpretations and relationships (advanced, read-only)</summary>
            <div className="mt-2">
              <VersionAdvanced version={version} />
            </div>
          </details>
        </div>
      )}
    </li>
  )
}

function VerificationAction({ version, onDone }: { version: SourceVersion; onDone: () => Promise<unknown> }) {
  const [status, setStatus] = useState<(typeof verificationChoices)[number]>('IN_REVIEW')
  return (
    <ConfirmAction
      trigger={
        <button type="button" className={linkButton}>
          Record verification
        </button>
      }
      title={`Record verification for version ${version.version}`}
      description="Records the verification outcome of this source version. The owner decides whether the change is allowed in the version's current state."
      confirmLabel="Record verification"
      subject="Source verification"
      onConfirm={async () => {
        await apiRequest(`/api/rule-source-versions/${version.id}/verification`, { method: 'POST', body: JSON.stringify({ verificationStatus: status }) })
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

export function SourceVersions({ sourceId, jurisdictionCode, writable }: { sourceId: string; jurisdictionCode: string; writable: boolean }) {
  const path = `/api/rule-sources/${sourceId}/versions`
  const versions = useOwnerItems<SourceVersion>(path, 'rule_source_version.read')
  const client = useQueryClient()
  // A lifecycle change on one version can change the recorded state of its siblings (supersession), so the
  // whole version list is re-read from the owner.
  const refresh = () => client.invalidateQueries({ queryKey: ownerKey(path) })

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-950">Versions</h3>
        {writable && (
          <PermissionGate permission="rule_source_version.create">
            <MasterFormDialog
              title="New source version"
              subject="Source version"
              fields={[
                { key: 'version', label: 'Version', required: true },
                { key: 'rawEvidenceRef', label: 'Evidence reference', required: true, hint: '(where the source text is held)' },
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
      {!versions.permitted && <EmptyState title="Source versions are not available to you." />}
      {versions.permitted && versions.isPending && <Skeleton className="h-16 w-full" />}
      {versions.isError && <p className="text-sm text-red-700">Source versions could not be loaded.</p>}
      {versions.data &&
        (versions.data.length === 0 ? (
          <EmptyState title="No version recorded for this source" />
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {versions.data.map((version) => (
              <VersionRow key={version.id} version={version} jurisdictionCode={jurisdictionCode} writable={writable} refresh={refresh} />
            ))}
          </ul>
        ))}
    </section>
  )
}
