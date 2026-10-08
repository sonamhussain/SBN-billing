import { useState, type FormEvent, type ReactNode } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { localInputToInstant } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import { EvidenceVersionPicker } from '../evidence/EvidenceVersionPicker.tsx'
import { useRecordEligibilityVerification } from './eligibility.queries.ts'
import { verificationMethods, verificationStatuses, type VerificationMethod, type VerificationStatus } from './eligibility.types.ts'

// FE-04 — "Record verification": stores an eligibility result that was already obtained outside SBN,
// with the exact response evidence version. Nothing is sent to a payer and nothing is verified here. The
// membership, payer and service date come from the Encounter on the server.

type TriState = '' | 'true' | 'false'

type Draft = {
  verificationMethod: VerificationMethod | ''
  status: VerificationStatus | ''
  requestedAt: string
  respondedAt: string
  validThrough: string
  authorizationRequired: TriState
  referralRequired: TriState
  responseEvidenceVersionId: string
  requestEvidenceVersionId: string
}

const emptyDraft: Draft = {
  verificationMethod: '',
  status: '',
  requestedAt: '',
  respondedAt: '',
  validThrough: '',
  authorizationRequired: '',
  referralRequired: '',
  responseEvidenceVersionId: '',
  requestEvidenceVersionId: '',
}

const triStateValue = (value: TriState) => (value === '' ? null : value === 'true')

function TriStateField({ label, value, onChange }: { label: string; value: TriState; onChange: (value: TriState) => void }) {
  return (
    <Field label={label} hint="(as reported)">
      <Select value={value} onChange={(e) => onChange(e.target.value as TriState)}>
        <option value="">Not recorded</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    </Field>
  )
}

export function EligibilityRecordDialog({ encounterId, trigger }: { encounterId: string; trigger: ReactNode }) {
  const record = useRecordEligibilityVerification(encounterId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const complete = draft.verificationMethod !== '' && draft.status !== '' && draft.responseEvidenceVersionId !== ''

  function onOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      setDraft(emptyDraft)
      record.reset()
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!complete) return
    try {
      await record.mutateAsync({
        verificationMethod: draft.verificationMethod as VerificationMethod,
        status: draft.status as VerificationStatus,
        requestedAt: localInputToInstant(draft.requestedAt),
        respondedAt: localInputToInstant(draft.respondedAt) ?? '',
        validThrough: localInputToInstant(draft.validThrough),
        authorizationRequired: triStateValue(draft.authorizationRequired),
        referralRequired: triStateValue(draft.referralRequired),
        responseEvidenceVersionId: draft.responseEvidenceVersionId,
        requestEvidenceVersionId: draft.requestEvidenceVersionId || null,
      })
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state; nothing was recorded.
    }
  }

  return (
    <Dialog trigger={trigger} title="Record verification" open={open} onOpenChange={onOpenChange}>
      <form className="space-y-3" onSubmit={submit}>
        {record.isError && <Alert tone="danger">{describeSaveError(record.error, 'Verification')}</Alert>}
        <p className="text-sm text-slate-500">Records a result already obtained from the payer, portal or a manual check. No request is sent from here.</p>
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Method">
            <Select required value={draft.verificationMethod} onChange={(e) => setDraft({ ...draft, verificationMethod: e.target.value as Draft['verificationMethod'] })}>
              <option value="">Select a method</option>
              {verificationMethods.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Reported status">
            <Select required value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Draft['status'] })}>
              <option value="">Select a status</option>
              {verificationStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Responded at">
            <Input type="datetime-local" required value={draft.respondedAt} onChange={(e) => setDraft({ ...draft, respondedAt: e.target.value })} />
          </Field>
          <Field label="Requested at" hint="(optional)">
            <Input type="datetime-local" value={draft.requestedAt} onChange={(e) => setDraft({ ...draft, requestedAt: e.target.value })} />
          </Field>
        </div>
        <Field label="Valid through" hint="(optional, as reported)">
          <Input type="datetime-local" value={draft.validThrough} onChange={(e) => setDraft({ ...draft, validThrough: e.target.value })} />
        </Field>
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <TriStateField label="Authorization required" value={draft.authorizationRequired} onChange={(value) => setDraft({ ...draft, authorizationRequired: value })} />
          <TriStateField label="Referral required" value={draft.referralRequired} onChange={(value) => setDraft({ ...draft, referralRequired: value })} />
        </div>
        <EvidenceVersionPicker
          label="Response evidence"
          required
          value={draft.responseEvidenceVersionId}
          onChange={(responseEvidenceVersionId) => setDraft({ ...draft, responseEvidenceVersionId })}
        />
        <EvidenceVersionPicker
          label="Request evidence"
          hint="(optional)"
          value={draft.requestEvidenceVersionId}
          onChange={(requestEvidenceVersionId) => setDraft({ ...draft, requestEvidenceVersionId })}
        />
        <div className="flex justify-end">
          <Button disabled={record.isPending || !complete} type="submit">
            {record.isPending ? 'Saving...' : 'Record verification'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
