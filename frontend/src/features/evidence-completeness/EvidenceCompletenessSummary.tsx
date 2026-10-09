import { useId, useState } from 'react'
import { describeApiFailure } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { formatDateOnly, formatInstant } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import { useActivityLabel } from '../encounter-activity/activity-label.ts'
import { useEncounterActivities } from '../encounter-activity/encounter-activity.queries.ts'
import type { EncounterActivity } from '../encounter-activity/encounter-activity.types.ts'
import { useEncounterDiagnoses } from '../encounter-diagnosis/encounter-diagnosis.queries.ts'
import { useEvaluateCompleteness } from './evidence-completeness.queries.ts'
import type { CompletenessTarget, RequirementCompleteness } from './evidence-completeness.types.ts'

// FE-04 — "Evaluate completeness": an explicit, read-only A5.6 evaluation. The default target is the
// Encounter; a specific active activity or diagnosis can be chosen under "Choose a target". Every returned
// requirement is shown on its own with the backend's state and counts. No overall "complete" flag is
// derived and nothing is kept after the page closes.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

function ActivityTargetOption({ activity }: { activity: EncounterActivity }) {
  return <option value={`activity:${activity.id}`}>{`Activity: ${useActivityLabel(activity)} — qty ${activity.quantity}`}</option>
}

function targetOf(value: string): CompletenessTarget {
  if (value.startsWith('activity:')) return { encounterActivityId: value.slice('activity:'.length) }
  if (value.startsWith('diagnosis:')) return { encounterDiagnosisId: value.slice('diagnosis:'.length) }
  return {}
}

function RequirementRow({ requirement }: { requirement: RequirementCompleteness }) {
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-slate-950">{requirement.acceptedDocumentTypes.join(', ')}</span>
        <OutcomeBadge value={requirement.state} />
      </div>
      <p className="mt-1 text-slate-600">
        Minimum {requirement.minimumCount}
        {requirement.sourceDateRequired ? ' · source date required' : ''}
        {requirement.maxSourceAgeDays !== null ? ` · at most ${requirement.maxSourceAgeDays} days old` : ''}
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
        Valid {requirement.validCount} · invalid {requirement.invalidCount} · stale {requirement.staleCount} · candidates {requirement.totalCandidateCount}
      </p>
    </li>
  )
}

export function EvidenceCompletenessSummary({ encounterId, blocked }: { encounterId: string; blocked: boolean }) {
  const { can } = usePermission()
  const targetId = useId()
  const [target, setTarget] = useState('')
  const evaluate = useEvaluateCompleteness(encounterId)
  const activities = useEncounterActivities(encounterId, can('encounterActivity.read'))
  const diagnoses = useEncounterDiagnoses(encounterId, can('encounterDiagnosis.read'))
  const result = evaluate.data

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Requirement completeness</h3>
          <p className="mt-0.5 text-xs text-slate-500">Evaluated on request from the governed evidence requirements. Nothing is saved.</p>
        </div>
        <PermissionGate permission="evidenceCompleteness.evaluate">
          <Button
            type="button"
            className={secondaryButton}
            disabled={evaluate.isPending || blocked}
            onClick={() => evaluate.mutate(targetOf(target))}
          >
            {evaluate.isPending ? 'Evaluating...' : 'Evaluate completeness'}
          </Button>
        </PermissionGate>
      </div>

      <PermissionGate permission="evidenceCompleteness.evaluate">
        <details className="text-sm">
          <summary className="cursor-pointer text-[var(--sbn-accent)]">Choose a target</summary>
          <div className="mt-2">
            <label htmlFor={targetId} className="font-medium text-slate-700">
              Evaluate for
            </label>
            <Select id={targetId} className="mt-1" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">This encounter</option>
              {(activities.data ?? []).map((activity) => (
                <ActivityTargetOption key={activity.id} activity={activity} />
              ))}
              {(diagnoses.data ?? []).map((diagnosis) => (
                <option key={diagnosis.id} value={`diagnosis:${diagnosis.id}`}>
                  {`Diagnosis: ${diagnosis.diagnosisCode.code} — ${diagnosis.diagnosisCode.displayName}`}
                </option>
              ))}
            </Select>
          </div>
        </details>
      </PermissionGate>

      {evaluate.isError && <Alert tone="danger">{describeApiFailure(evaluate.error, 'Evidence completeness')}</Alert>}

      {result && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Evaluated {formatInstant(result.evaluatedAt)} for{' '}
            {result.encounterActivityId ? 'one activity' : result.encounterDiagnosisId ? 'one diagnosis' : 'the encounter'} · business date{' '}
            {formatDateOnly(result.businessDate)}
          </p>
          {result.requirements.length === 0 ? (
            <p className="text-sm text-slate-600">No governed evidence requirement applies to this target.</p>
          ) : (
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {result.requirements.map((requirement) => (
                <RequirementRow key={requirement.evidenceRequirementId} requirement={requirement} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
