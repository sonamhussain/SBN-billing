import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { apiRequest } from '../../shared/api/client.ts'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { formatDateOnly, formatInstant } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { ConfirmAction } from '../admin/ConfirmAction.tsx'
import { MasterFormDialog } from '../admin/MasterFormDialog.tsx'
import { ownerKey, useOwnerItems } from '../admin/owner-query.ts'

// FE-05 — a provider contract's tariff schedules and each schedule's versions (REF-01). A version carries an
// identity, recorded effective dates and a verification status; it carries no rate, amount or price, and
// none is shown or entered. A VERIFIED or REJECTED version is final on the server, so its dates and status
// are no longer offered for change; a correction is a new version.

type TariffSchedule = { id: string; providerContractId: string; tariffKey: string; displayName: string }
type TariffVersion = {
  id: string
  tariffScheduleId: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
}

const finalStatuses = ['VERIFIED', 'REJECTED']
const verificationChoices = ['IN_REVIEW', 'VERIFIED', 'REJECTED'] as const

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
const linkButton = 'rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100'
// A period with neither end recorded reads as one "Not recorded" rather than two placeholders.
const period = (from: string | null, to: string | null) =>
  !from && !to ? 'Not recorded' : `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function useRefresh(path: string) {
  const client = useQueryClient()
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ownerKey(path) }),
      // The A5.5 commercial resolution reads these records; it is re-read the next time it is opened.
      client.invalidateQueries({ queryKey: ['pre-claim-commercial-context'] }),
    ])
}

function VersionDatesDialog({ version, versionsPath }: { version: TariffVersion; versionsPath: string }) {
  const refresh = useRefresh(versionsPath)
  const [open, setOpen] = useState(false)
  const [dates, setDates] = useState({ effectiveFrom: version.effectiveFrom ?? '', effectiveTo: version.effectiveTo ?? '' })
  const save = useMutation({
    mutationFn: () =>
      apiRequest(`/api/tariff-schedule-versions/${version.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ effectiveFrom: dates.effectiveFrom || null, effectiveTo: dates.effectiveTo || null }),
      }),
    onSuccess: refresh,
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDates({ effectiveFrom: version.effectiveFrom ?? '', effectiveTo: version.effectiveTo ?? '' })
    save.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await save.mutateAsync()
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state.
    }
  }

  return (
    <Dialog title={`Edit dates of version ${version.version}`} open={open} onOpenChange={onOpenChange} trigger={<button type="button" className={linkButton}>Edit dates</button>}>
      <form className="space-y-3" onSubmit={submit}>
        {save.isError && <Alert tone="danger">{describeSaveError(save.error, 'Tariff version')}</Alert>}
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Effective from" hint="(optional)">
            <Input type="date" value={dates.effectiveFrom} onChange={(e) => setDates({ ...dates, effectiveFrom: e.target.value })} />
          </Field>
          <Field label="Effective to" hint="(optional)">
            <Input type="date" value={dates.effectiveTo} onChange={(e) => setDates({ ...dates, effectiveTo: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving...' : 'Save dates'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function VerificationAction({ version, versionsPath }: { version: TariffVersion; versionsPath: string }) {
  const refresh = useRefresh(versionsPath)
  const [status, setStatus] = useState<(typeof verificationChoices)[number]>('IN_REVIEW')
  return (
    <ConfirmAction
      trigger={
        <button type="button" className={linkButton}>
          Record verification
        </button>
      }
      title={`Record verification for version ${version.version}`}
      description="Records the verification outcome of this tariff version. VERIFIED and REJECTED are final: the version can no longer be changed afterwards, and a correction is a new version."
      confirmLabel="Record verification"
      subject="Tariff verification"
      onConfirm={async () => {
        await apiRequest(`/api/tariff-schedule-versions/${version.id}/verification`, { method: 'POST', body: JSON.stringify({ verificationStatus: status }) })
        await refresh()
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

function CreateVersionDialog({ scheduleId, versionsPath }: { scheduleId: string; versionsPath: string }) {
  const refresh = useRefresh(versionsPath)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ version: '', effectiveFrom: '', effectiveTo: '' })
  const create = useMutation({
    mutationFn: () =>
      apiRequest(`/api/tariff-schedules/${scheduleId}/versions`, {
        method: 'POST',
        body: JSON.stringify({ version: draft.version, effectiveFrom: draft.effectiveFrom || null, effectiveTo: draft.effectiveTo || null }),
      }),
    onSuccess: refresh,
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDraft({ version: '', effectiveFrom: '', effectiveTo: '' })
    create.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await create.mutateAsync()
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state.
    }
  }

  return (
    <Dialog title="New tariff version" open={open} onOpenChange={onOpenChange} trigger={<Button className={secondaryButton}>New version</Button>}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Tariff version')}</Alert>}
        <Field label="Version">
          <Input required autoComplete="off" value={draft.version} onChange={(e) => setDraft({ ...draft, version: e.target.value })} />
        </Field>
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Effective from" hint="(optional)">
            <Input type="date" value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
          </Field>
          <Field label="Effective to" hint="(optional)">
            <Input type="date" value={draft.effectiveTo} onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Saving...' : 'Create version'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ScheduleVersions({ schedule }: { schedule: TariffSchedule }) {
  const versionsPath = `/api/tariff-schedules/${schedule.id}/versions`
  const versions = useOwnerItems<TariffVersion>(versionsPath, 'tariff_schedule_version.read')
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <h5 className="text-xs font-medium uppercase tracking-wide text-slate-500">Versions</h5>
        <PermissionGate permission="tariff_schedule_version.create">
          <CreateVersionDialog scheduleId={schedule.id} versionsPath={versionsPath} />
        </PermissionGate>
      </div>
      {!versions.permitted && <p className="text-xs text-slate-500">Tariff versions are not available to you.</p>}
      {versions.permitted && versions.isPending && <Skeleton className="h-8 w-full" />}
      {versions.isError && <p className="text-xs text-red-700">Tariff versions could not be loaded.</p>}
      {versions.data &&
        (versions.data.length === 0 ? (
          <p className="text-xs text-slate-500">No version recorded.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {versions.data.map((version) => {
              const final = finalStatuses.includes(version.verificationStatus)
              return (
                <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-950">Version {version.version}</p>
                    <p className="text-xs text-slate-500">
                      {period(version.effectiveFrom, version.effectiveTo)}
                      {version.verifiedAt ? ` · verified ${formatInstant(version.verifiedAt)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <OutcomeBadge value={version.verificationStatus} />
                    {!final && (
                      <PermissionGate permission="tariff_schedule_version.lifecycle">
                        <VersionDatesDialog version={version} versionsPath={versionsPath} />
                        <VerificationAction version={version} versionsPath={versionsPath} />
                      </PermissionGate>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        ))}
    </div>
  )
}

export function TariffSchedules({ contractId }: { contractId: string }) {
  const path = `/api/provider-contracts/${contractId}/tariff-schedules`
  const schedules = useOwnerItems<TariffSchedule>(path, 'tariff_schedule.read')
  const refresh = useRefresh(path)
  const [openId, setOpenId] = useState('')
  const fields = [
    { key: 'tariffKey', label: 'Tariff key', required: true },
    { key: 'displayName', label: 'Display name', required: true },
  ]

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-950">Tariff schedules</h3>
        <PermissionGate permission="tariff_schedule.create">
          <MasterFormDialog
            title="New tariff schedule"
            subject="Tariff schedule"
            fields={fields}
            trigger={<Button className={secondaryButton}>New tariff schedule</Button>}
            onSubmit={async (body) => {
              await apiRequest(path, { method: 'POST', body: JSON.stringify(body) })
              await refresh()
            }}
          />
        </PermissionGate>
      </div>
      {!schedules.permitted && <EmptyState title="Tariff schedules are not available to you." />}
      {schedules.permitted && schedules.isPending && <Skeleton className="h-12 w-full" />}
      {schedules.isError && <p className="text-sm text-red-700">Tariff schedules could not be loaded.</p>}
      {schedules.data &&
        (schedules.data.length === 0 ? (
          <EmptyState title="No tariff schedule recorded for this contract" />
        ) : (
          <ul className="space-y-2">
            {schedules.data.map((schedule) => (
              <li key={schedule.id} className="space-y-2 rounded-md border border-slate-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-slate-950">
                    {schedule.displayName} <span className="font-normal text-slate-500">({schedule.tariffKey})</span>
                  </p>
                  <div className="flex items-center gap-1">
                    <PermissionGate permission="tariff_schedule.update">
                      <MasterFormDialog
                        title="Rename tariff schedule"
                        subject="Tariff schedule"
                        fields={[{ key: 'displayName', label: 'Display name', required: true }]}
                        record={schedule}
                        trigger={
                          <button type="button" className={linkButton}>
                            Rename
                          </button>
                        }
                        onSubmit={async (patch) => {
                          await apiRequest(`/api/tariff-schedules/${schedule.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
                          await refresh()
                        }}
                      />
                    </PermissionGate>
                    <button
                      type="button"
                      aria-expanded={openId === schedule.id}
                      className={linkButton}
                      onClick={() => setOpenId(openId === schedule.id ? '' : schedule.id)}
                    >
                      {openId === schedule.id ? 'Hide versions' : 'Versions'}
                    </button>
                  </div>
                </div>
                {openId === schedule.id && <ScheduleVersions schedule={schedule} />}
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}
