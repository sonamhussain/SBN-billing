import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import { OptionPicker } from '../encounter-lookups/OptionPicker.tsx'
import { useDiagnosisCodeOptions, useProcedureCodeOptions, useServiceOptions } from '../encounter-lookups/encounter-lookups.queries.ts'
import { useCaptureAuthorizationLines } from './authorization.queries.ts'
import { lineStatuses, type AuthorizationLineInput, type LineStatus } from './authorization.types.ts'

// FE-04 — "Capture authorized scope": the complete line set for one exact authorization version, sent as
// one non-empty batch. It can be captured only once; a correction is a new authorization version. Service
// and procedure are independent (at least one per line) and never inferred from each other; quantities
// stay the exact text entered.

type LineDraft = {
  key: number
  serviceId: string
  procedureCodeId: string
  diagnosisCodeId: string
  requestedQty: string
  approvedQty: string
  unitCode: string
  approvedFrom: string
  approvedThrough: string
  status: LineStatus | ''
}

const emptyLine = (key: number): LineDraft => ({
  key,
  serviceId: '',
  procedureCodeId: '',
  diagnosisCodeId: '',
  requestedQty: '',
  approvedQty: '',
  unitCode: '',
  approvedFrom: '',
  approvedThrough: '',
  status: '',
})

const lineComplete = (line: LineDraft) => (line.serviceId !== '' || line.procedureCodeId !== '') && line.requestedQty.trim() !== '' && line.status !== ''

function toInput(line: LineDraft): AuthorizationLineInput {
  return {
    serviceId: line.serviceId || null,
    procedureCodeId: line.procedureCodeId || null,
    diagnosisCodeId: line.diagnosisCodeId || null,
    requestedQty: line.requestedQty,
    approvedQty: line.approvedQty.trim() === '' ? null : line.approvedQty,
    unitCode: line.unitCode.trim() || null,
    approvedFrom: line.approvedFrom || null,
    approvedThrough: line.approvedThrough || null,
    status: line.status as LineStatus,
  }
}

export function AuthorizationLinesDialog({ versionId, trigger }: { versionId: string; trigger: ReactNode }) {
  const { organizationId } = useOrganization()
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(0)])
  const [nextKey, setNextKey] = useState(1)
  const services = useServiceOptions(organizationId, open)
  const procedures = useProcedureCodeOptions(organizationId, open)
  const diagnoses = useDiagnosisCodeOptions(organizationId, open)
  const capture = useCaptureAuthorizationLines(versionId)
  const complete = lines.length > 0 && lines.every(lineComplete)

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setLines([emptyLine(0)])
      setNextKey(1)
      capture.reset()
    }
  }

  const update = (key: number, patch: Partial<LineDraft>) => setLines(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)))

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!complete) return
    try {
      await capture.mutateAsync(lines.map(toInput))
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; no line was captured.
    }
  }

  return (
    <Dialog trigger={trigger} title="Capture authorized scope" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-4" onSubmit={submit}>
        {capture.isError && <Alert tone="danger">{describeSaveError(capture.error, 'Authorized scope')}</Alert>}
        <p className="text-sm text-slate-500">
          All lines for this version are saved together and cannot be changed afterwards. A correction is recorded as a new authorization version.
        </p>
        {lines.map((line, index) => (
          <fieldset key={line.key} className="space-y-3 rounded-md border border-slate-200 p-3">
            <legend className="sr-only">Line {index + 1}</legend>
            <div className="flex items-center justify-between">
              <span aria-hidden="true" className="text-sm font-semibold text-slate-950">
                Line {index + 1}
              </span>
              {lines.length > 1 && (
                <button
                  type="button"
                  className="rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
                  onClick={() => setLines(lines.filter((item) => item.key !== line.key))}
                >
                  Remove line
                </button>
              )}
            </div>
            <OptionPicker
              label="Service"
              hint="(service and/or procedure)"
              value={line.serviceId}
              onChange={(serviceId) => update(line.key, { serviceId })}
              options={services.data?.map((service) => ({ value: service.id, label: `${service.internalCode} — ${service.displayName}` }))}
              placeholder="Not recorded"
              loading={services.isPending && services.permitted}
              unavailable={!services.permitted || services.isError}
            />
            <OptionPicker
              label="Procedure"
              value={line.procedureCodeId}
              onChange={(procedureCodeId) => update(line.key, { procedureCodeId })}
              options={procedures.data?.map((procedure) => ({ value: procedure.id, label: `${procedure.internalCode} — ${procedure.displayName}` }))}
              placeholder="Not recorded"
              loading={procedures.isPending && procedures.permitted}
              unavailable={!procedures.permitted || procedures.isError}
            />
            <OptionPicker
              label="Diagnosis"
              hint="(optional)"
              value={line.diagnosisCodeId}
              onChange={(diagnosisCodeId) => update(line.key, { diagnosisCodeId })}
              options={diagnoses.data?.map((code) => ({ value: code.id, label: `${code.code} — ${code.displayName}` }))}
              placeholder="Not recorded"
              loading={diagnoses.isPending && diagnoses.permitted}
              unavailable={!diagnoses.permitted || diagnoses.isError}
            />
            <div className="grid items-end gap-3 sm:grid-cols-3">
              <Field label="Requested qty">
                <Input required inputMode="decimal" autoComplete="off" value={line.requestedQty} onChange={(e) => update(line.key, { requestedQty: e.target.value })} />
              </Field>
              <Field label="Approved qty" hint="(optional)">
                <Input inputMode="decimal" autoComplete="off" value={line.approvedQty} onChange={(e) => update(line.key, { approvedQty: e.target.value })} />
              </Field>
              <Field label="Unit code" hint="(optional)">
                <Input autoComplete="off" value={line.unitCode} onChange={(e) => update(line.key, { unitCode: e.target.value })} />
              </Field>
            </div>
            <div className="grid items-end gap-3 sm:grid-cols-3">
              <Field label="Approved from" hint="(optional)">
                <Input type="date" value={line.approvedFrom} onChange={(e) => update(line.key, { approvedFrom: e.target.value })} />
              </Field>
              <Field label="Approved through" hint="(optional)">
                <Input type="date" value={line.approvedThrough} onChange={(e) => update(line.key, { approvedThrough: e.target.value })} />
              </Field>
              <Field label="Line status">
                <Select required value={line.status} onChange={(e) => update(line.key, { status: e.target.value as LineDraft['status'] })}>
                  <option value="">Select</option>
                  {lineStatuses.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </fieldset>
        ))}
        <button
          type="button"
          className="text-sm text-[var(--sbn-accent)] hover:underline"
          onClick={() => {
            setLines([...lines, emptyLine(nextKey)])
            setNextKey(nextKey + 1)
          }}
        >
          Add line
        </button>
        <div className="flex items-center justify-end gap-3">
          {!complete && <p className="text-xs text-slate-500">Each line needs a service or procedure chosen from the list, a requested quantity and a line status.</p>}
          <Button disabled={capture.isPending || !complete} type="submit">
            {capture.isPending ? 'Saving...' : `Capture ${lines.length} line${lines.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
