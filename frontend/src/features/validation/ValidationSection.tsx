import { useState } from 'react'
import { describeApiFailure, describeSaveError } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { formatInstantPrecise } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { RecordSection } from '../../shared/ui/RecordSection.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { readinessLabel } from '../readiness/readiness-wording.ts'
import { useEncounterReadiness, useRecordReadiness } from '../readiness/readiness.queries.ts'
import type { ReadinessAssessment } from '../readiness/readiness.types.ts'
import { FindingList } from './FindingList.tsx'
import { useExecuteValidation, useRunFindings, useValidationRuns } from './validation.queries.ts'
import type { ValidationRun } from './validation.types.ts'

// FE-04 — Validation: every immutable run in the backend's order, none labelled current or best. "Run
// validation" records a new run (HTTP 201 means it was recorded, even when findings FAIL or RESTRICT) and
// opens it; it never records readiness. Readiness is recorded only by an explicit action inside one exact
// run, and only when that run has no assessment yet.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

// `readinessKnown` is true only when the readiness history has loaded, so "no assessment" is a fact.
function RunPanel({
  run,
  encounterId,
  assessment,
  readinessKnown,
  blocked,
}: {
  run: ValidationRun
  encounterId: string
  assessment: ReadinessAssessment | undefined
  readinessKnown: boolean
  blocked: boolean
}) {
  const findings = useRunFindings(run.id, true)
  const record = useRecordReadiness(encounterId)

  return (
    <div className="space-y-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
      {findings.isPending && <Skeleton className="h-16 w-full" />}
      {findings.isError && <p className="text-sm text-red-700">Findings could not be loaded.</p>}
      {findings.data && <FindingList findings={findings.data} />}

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3 text-sm">
        {assessment ? (
          <>
            <span className="text-slate-500">Readiness recorded for this run:</span>
            <OutcomeBadge value={assessment.state} label={readinessLabel(assessment.state)} />
          </>
        ) : readinessKnown ? (
          <>
            <span className="text-slate-500">No readiness recorded for this run.</span>
            {!blocked && (
              <PermissionGate permission="preClaimReadiness.evaluate">
                <Button type="button" className={secondaryButton} disabled={record.isPending} onClick={() => record.mutate(run.id)}>
                  {record.isPending ? 'Recording...' : 'Record readiness for this validation'}
                </Button>
              </PermissionGate>
            )}
          </>
        ) : null}
      </div>
      {record.isError && <Alert tone="danger">{describeSaveError(record.error, 'Readiness')}</Alert>}
    </div>
  )
}

export function ValidationSection({ encounterId, blocked }: { encounterId: string; blocked: boolean }) {
  const { can } = usePermission()
  const runs = useValidationRuns(encounterId, can('validationRun.read'))
  const readiness = useEncounterReadiness(encounterId, can('preClaimReadiness.read'))
  const execute = useExecuteValidation(encounterId)
  const [openRunId, setOpenRunId] = useState('')

  async function runValidation() {
    try {
      const result = await execute.mutateAsync()
      setOpenRunId(result.validationRunId)
    } catch {
      // Shown below from the mutation state; no run was recorded.
    }
  }

  const assessmentFor = (runId: string) => readiness.data?.find((assessment) => assessment.validationRunId === runId)

  return (
    <RecordSection
      title="Validation"
      description="Recorded validation runs and their findings. Each run is kept as history; none is treated as current."
      action={
        <PermissionGate permission="preClaimValidation.execute">
          <Button type="button" disabled={execute.isPending || blocked} onClick={runValidation}>
            {execute.isPending ? 'Running...' : 'Run validation'}
          </Button>
        </PermissionGate>
      }
    >
      <div className="space-y-3">
        {execute.isError && <Alert tone="danger">{describeApiFailure(execute.error, 'Validation')}</Alert>}
        {!can('validationRun.read') && <EmptyState title="Validation history is not available to you." />}
        {can('validationRun.read') && runs.isPending && <Skeleton className="h-16 w-full" />}
        {runs.isError && !runs.data && (
          <p role="alert" className="text-sm text-red-700">
            Validation history could not be loaded.
          </p>
        )}
        {runs.data &&
          (runs.data.length === 0 ? (
            <EmptyState title="No validation run recorded" />
          ) : (
            <ul className="space-y-2">
              {runs.data.map((run) => {
                const open = openRunId === run.id
                return (
                  <li key={run.id} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <button
                      type="button"
                      aria-expanded={open}
                      className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-slate-50"
                      onClick={() => setOpenRunId(open ? '' : run.id)}
                    >
                      <span className="font-medium text-slate-950">Run evaluated {formatInstantPrecise(run.evaluatedAt)}</span>
                      <span className="text-xs text-slate-500">
                        {run.validatorVersion} · {run.findingCount} finding{run.findingCount === 1 ? '' : 's'} · {open ? 'Hide' : 'Show'} findings
                      </span>
                    </button>
                    {open && (
                      <RunPanel
                        run={run}
                        encounterId={encounterId}
                        assessment={assessmentFor(run.id)}
                        readinessKnown={readiness.data !== undefined}
                        blocked={blocked}
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          ))}
      </div>
    </RecordSection>
  )
}
