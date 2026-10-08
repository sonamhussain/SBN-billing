import { useState } from 'react'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { formatInstantPrecise } from '../../shared/format/date.ts'
import { Button } from '../../shared/ui/Button.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { RecordSection } from '../../shared/ui/RecordSection.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useValidationRuns } from '../validation/validation.queries.ts'
import { A6HandoffSummary } from './A6HandoffSummary.tsx'
import { readinessLabel } from './readiness-wording.ts'
import { useEncounterReadiness, useReadinessDetail } from './readiness.queries.ts'
import type { ReadinessAssessment, ReadinessReasonRef } from './readiness.types.ts'

// FE-04 — Readiness: every immutable assessment in the backend's order, each tied to its exact validation
// run. Earlier BLOCKED/RESTRICTED records stay visible after later corrections. A READY_FOR_REVIEW
// assessment may open its pre-claim handoff; nothing here submits, approves or creates a claim.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

function ReasonList({ title, items }: { title: string; items: ReadinessReasonRef[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500">{title}</dt>
      <dd className="font-mono text-xs text-slate-700">{items.map((item) => `#${item.sequence} ${item.findingCode}`).join(', ')}</dd>
    </div>
  )
}

function AssessmentRow({ assessment, runLabel }: { assessment: ReadinessAssessment; runLabel: string }) {
  const [open, setOpen] = useState(false)
  const [handoff, setHandoff] = useState(false)
  const detail = useReadinessDetail(assessment.id, open)

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <OutcomeBadge value={assessment.state} label={readinessLabel(assessment.state)} />
        <span className="text-xs text-slate-500">
          Assessed {formatInstantPrecise(assessment.assessedAt)} · {assessment.readinessPolicyVersion} · {runLabel}
        </span>
        <button
          type="button"
          aria-expanded={open}
          className="ml-auto rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide reasons' : 'Reasons'}
        </button>
      </div>
      {open && (
        <div className="mt-2 rounded-md bg-slate-50 p-3">
          {detail.isPending && <Skeleton className="h-8 w-full" />}
          {detail.isError && <p className="text-xs text-red-700">Reasons could not be loaded.</p>}
          {detail.data && (
            <dl className="space-y-1">
              <ReasonList title="Blocking findings" items={detail.data.reasons.blockedFindings} />
              <ReasonList title="Restricting findings" items={detail.data.reasons.restrictedFindings} />
              <ReasonList title="Warning findings" items={detail.data.reasons.warningFindings} />
              <ReasonList title="Passing findings" items={detail.data.reasons.passFindings} />
            </dl>
          )}
        </div>
      )}
      {assessment.state === 'READY_FOR_REVIEW' && (
        <PermissionGate permission="preClaimA6Handoff.read">
          <div className="mt-2 space-y-2">
            <Button type="button" className={secondaryButton} onClick={() => setHandoff(!handoff)}>
              {handoff ? 'Hide A6 handoff' : 'View A6 handoff'}
            </Button>
            {handoff && <A6HandoffSummary assessmentId={assessment.id} />}
          </div>
        </PermissionGate>
      )}
    </li>
  )
}

export function ReadinessSection({ encounterId }: { encounterId: string }) {
  const { can } = usePermission()
  const readiness = useEncounterReadiness(encounterId, can('preClaimReadiness.read'))
  const runs = useValidationRuns(encounterId, can('validationRun.read'))
  const runLabel = (runId: string) => {
    const run = runs.data?.find((item) => item.id === runId)
    return run ? `run evaluated ${formatInstantPrecise(run.evaluatedAt)}` : 'validation run'
  }

  return (
    <RecordSection
      title="Readiness"
      description="Readiness recorded for exact validation runs. Ready for review means human claim review may begin — not approval or submission."
    >
      {!can('preClaimReadiness.read') && <EmptyState title="Readiness history is not available to you." />}
      {can('preClaimReadiness.read') && readiness.isPending && <Skeleton className="h-16 w-full" />}
      {readiness.isError && !readiness.data && (
        <p role="alert" className="text-sm text-red-700">
          Readiness history could not be loaded.
        </p>
      )}
      {readiness.data &&
        (readiness.data.length === 0 ? (
          <EmptyState title="No readiness recorded" message="Record readiness from an exact validation run above." />
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {readiness.data.map((assessment) => (
              <AssessmentRow key={assessment.id} assessment={assessment} runLabel={runLabel(assessment.validationRunId)} />
            ))}
          </ul>
        ))}
    </RecordSection>
  )
}
