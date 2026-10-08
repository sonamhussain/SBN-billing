import { describeApiFailure } from '../../shared/api/error-message.ts'
import { formatInstantPrecise } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useA6Handoff } from './readiness.queries.ts'

// FE-04 — "Pre-claim handoff": the exact A5.9 handoff for one READY_FOR_REVIEW assessment, as the backend
// returns it — counts and references only. It is not a claim or a claim evidence package: there is no
// claim, line, price, approver, payload or transmission, and none is shown. When a newer validation run
// supersedes this assessment, the backend's refusal is shown instead.
export function A6HandoffSummary({ assessmentId }: { assessmentId: string }) {
  const handoff = useA6Handoff(assessmentId, true)

  if (handoff.isPending) return <Skeleton className="h-16 w-full" />
  if (handoff.isError) return <Alert tone="danger">{describeApiFailure(handoff.error, 'Pre-claim handoff')}</Alert>

  const data = handoff.data
  const summary = data.findingSummary
  const references = Object.entries(data.exactReferences)

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-white p-3 text-sm">
      <p className="font-medium text-slate-950">Pre-claim handoff</p>
      <p className="text-xs text-slate-500">
        Validation run evaluated {formatInstantPrecise(data.validationRun.evaluatedAt)} · {data.validationRun.validatorVersion} · readiness policy{' '}
        {data.readinessPolicyVersion}
      </p>
      <p className="text-slate-700">
        Findings {summary.total}: pass {summary.pass} · warning {summary.warning} · restrict {summary.restrict} · fail {summary.fail}
      </p>
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer text-[var(--sbn-accent)]">Exact references</summary>
        <dl className="mt-2 space-y-1">
          {references.map(([name, ids]) => (
            <div key={name}>
              <dt className="font-medium text-slate-500">
                {name} ({ids.length})
              </dt>
              {ids.length > 0 && <dd className="break-all font-mono">{ids.join(', ')}</dd>}
            </div>
          ))}
        </dl>
      </details>
    </div>
  )
}
