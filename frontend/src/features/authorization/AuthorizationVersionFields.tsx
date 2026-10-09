import { usePermission } from '../../shared/auth/usePermission.ts'
import { formatInstant } from '../../shared/format/date.ts'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import { useEligibilityVerifications } from '../eligibility/eligibility.queries.ts'
import { EvidenceVersionPicker } from '../evidence/EvidenceVersionPicker.tsx'
import { isDecisionStatus, type AuthorizationDraft } from './authorization-form.ts'
import { appendVersionKinds, authorizationStatuses, evidenceRoles, type EvidenceRole } from './authorization.types.ts'

// FE-04 — the fields of one authorization version. Recording the first version fixes its kind to INITIAL;
// a later version chooses what changed (response, amendment, extension or correction). The optional
// eligibility link offers only this Encounter's recorded verifications. Evidence links (at least one) pair
// a role with one exact evidence version. No value is interpreted here.
export function AuthorizationVersionFields({
  encounterId,
  draft,
  onChange,
  firstVersion,
}: {
  encounterId: string
  draft: AuthorizationDraft
  onChange: (next: AuthorizationDraft) => void
  firstVersion: boolean
}) {
  const { can } = usePermission()
  const verifications = useEligibilityVerifications(encounterId, can('eligibilityVerification.read'))
  // The backend requires a response time for a decision status; the form marks it so the user sees which
  // field is needed before saving. The backend still validates the whole version.
  const decision = isDecisionStatus(draft.status)
  const set = <K extends keyof AuthorizationDraft>(key: K, value: AuthorizationDraft[K]) => onChange({ ...draft, [key]: value })

  function addLink() {
    const key = Math.max(-1, ...draft.evidenceLinks.map((link) => link.key)) + 1
    set('evidenceLinks', [...draft.evidenceLinks, { key, role: '', evidenceArtifactVersionId: '' }])
  }

  return (
    <>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Version kind">
          {firstVersion ? (
            <Input value="INITIAL" readOnly aria-readonly="true" />
          ) : (
            <Select required value={draft.versionKind} onChange={(e) => set('versionKind', e.target.value as AuthorizationDraft['versionKind'])}>
              <option value="">Select what changed</option>
              {appendVersionKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Recorded status">
          <Select required value={draft.status} onChange={(e) => set('status', e.target.value as AuthorizationDraft['status'])}>
            <option value="">Select a status</option>
            {authorizationStatuses.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Responded at" hint={decision ? '(required: this status is a payer decision)' : '(optional until a decision is recorded)'}>
        <Input type="datetime-local" required={decision} value={draft.respondedAt} onChange={(e) => set('respondedAt', e.target.value)} />
      </Field>
      <Field label="Authorization reference" hint="(optional, as issued by the payer)">
        <Input autoComplete="off" value={draft.authorizationReference} onChange={(e) => set('authorizationReference', e.target.value)} />
      </Field>
      <Field label="Related eligibility verification" hint="(optional)">
        <Select value={draft.eligibilityVerificationId} onChange={(e) => set('eligibilityVerificationId', e.target.value)} disabled={!verifications.data}>
          <option value="">{verifications.data ? 'None' : 'Verifications are unavailable'}</option>
          {(verifications.data ?? []).map((verification) => (
            <option key={verification.id} value={verification.id}>
              {`${verification.status} · ${verification.verificationMethod} · responded ${formatInstant(verification.respondedAt)}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Requested at" hint="(optional)">
        <Input type="datetime-local" value={draft.requestedAt} onChange={(e) => set('requestedAt', e.target.value)} />
      </Field>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Valid from" hint="(optional)">
          <Input type="date" value={draft.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
        </Field>
        <Field label="Valid through" hint="(optional)">
          <Input type="date" value={draft.validThrough} onChange={(e) => set('validThrough', e.target.value)} />
        </Field>
      </div>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-slate-700">
          Evidence links <span className="font-normal text-slate-500">(at least one; a decision needs RESPONSE evidence)</span>
        </legend>
        {draft.evidenceLinks.map((link, index) => (
          <div key={link.key} className="space-y-2 rounded-md border border-slate-200 p-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field label={`Role ${index + 1}`}>
                  <Select
                    required
                    value={link.role}
                    onChange={(e) =>
                      set(
                        'evidenceLinks',
                        draft.evidenceLinks.map((item) => (item.key === link.key ? { ...item, role: e.target.value as EvidenceRole } : item)),
                      )
                    }
                  >
                    <option value="">Select a role</option>
                    {evidenceRoles.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {draft.evidenceLinks.length > 1 && (
                <button
                  type="button"
                  className="mb-1 rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100"
                  onClick={() => set('evidenceLinks', draft.evidenceLinks.filter((item) => item.key !== link.key))}
                >
                  Remove
                </button>
              )}
            </div>
            <EvidenceVersionPicker
              label={`Evidence ${index + 1}`}
              required
              value={link.evidenceArtifactVersionId}
              onChange={(versionId) =>
                set(
                  'evidenceLinks',
                  draft.evidenceLinks.map((item) => (item.key === link.key ? { ...item, evidenceArtifactVersionId: versionId } : item)),
                )
              }
            />
          </div>
        ))}
        <button type="button" className="text-sm text-[var(--sbn-accent)] hover:underline" onClick={addLink}>
          Add evidence link
        </button>
      </fieldset>
    </>
  )
}
