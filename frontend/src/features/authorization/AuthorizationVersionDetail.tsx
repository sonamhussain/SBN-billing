import { useState } from 'react'
import { describeApiFailure } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { formatDateOnly, formatInstant } from '../../shared/format/date.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { useActivityLabel } from '../encounter-activity/activity-label.ts'
import { useEncounterActivities } from '../encounter-activity/encounter-activity.queries.ts'
import type { EncounterActivity } from '../encounter-activity/encounter-activity.types.ts'
import { useDiagnosisCodeName, useProcedureCodeName, useServiceName } from '../encounter-lookups/encounter-lookups.queries.ts'
import { EvidenceVersionLabel } from '../evidence/EvidenceVersionLabel.tsx'
import { useAuthorizationLines, useAuthorizationScope } from './authorization.queries.ts'
import type { AuthorizationLine, PriorAuthorizationVersion } from './authorization.types.ts'
import { AuthorizationLinesDialog } from './AuthorizationLinesDialog.tsx'

// FE-04 — one immutable authorization version: its recorded fields and evidence, its captured line scope
// and, on request, the read-only scope evaluation. Outcomes are the backend's exact values; a MATCHED
// activity is not "authorization satisfied" — governed coverage is decided by validation.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

function LineRow({ line }: { line: AuthorizationLine }) {
  const service = useServiceName(line.serviceId)
  const procedure = useProcedureCodeName(line.procedureCodeId)
  const diagnosis = useDiagnosisCodeName(line.diagnosisCodeId)
  return (
    <tr className="align-top">
      <td className="px-3 py-2 tabular-nums text-slate-500">{line.sequence}</td>
      <td className="px-3 py-2">
        {service && <div className="text-slate-950">{service}</div>}
        {procedure && <div className={service ? 'text-slate-600' : 'text-slate-950'}>{procedure}</div>}
        {diagnosis && <div className="text-xs text-slate-500">Diagnosis {diagnosis}</div>}
      </td>
      <td className="px-3 py-2 tabular-nums">{line.requestedQty}</td>
      <td className="px-3 py-2 tabular-nums">{line.approvedQty ?? <span className="text-slate-400">Not recorded</span>}</td>
      <td className="px-3 py-2">{line.unitCode ?? <span className="text-slate-400">—</span>}</td>
      <td className="px-3 py-2 text-xs">
        {line.approvedFrom || line.approvedThrough ? `${formatDateOnly(line.approvedFrom)} – ${formatDateOnly(line.approvedThrough)}` : <span className="text-slate-400">Not recorded</span>}
      </td>
      <td className="px-3 py-2 text-xs">{line.status}</td>
    </tr>
  )
}

function ActivityName({ activity }: { activity: EncounterActivity }) {
  return <>{`${useActivityLabel(activity)} — qty ${activity.quantity}`}</>
}

function ScopeResult({ versionId, lines, encounterId }: { versionId: string; lines: AuthorizationLine[]; encounterId: string }) {
  const { can } = usePermission()
  const scope = useAuthorizationScope(versionId, true)
  const activities = useEncounterActivities(encounterId, can('encounterActivity.read'))
  const lineNumber = (lineId: string | null) => (lineId === null ? null : (lines.find((line) => line.id === lineId)?.sequence ?? null))

  if (scope.isPending) return <Skeleton className="h-16 w-full" />
  if (scope.isError) return <Alert tone="danger">{describeApiFailure(scope.error, 'Scope evaluation')}</Alert>

  const result = scope.data
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-3 text-sm">
      <p className="text-xs text-slate-500">
        Evaluated {formatInstant(result.evaluatedAt)} · context matches the encounter: {result.contextMatch ? 'yes' : 'no'}
      </p>
      {result.activities.length === 0 ? (
        <p className="text-slate-600">The encounter has no active activity to compare.</p>
      ) : (
        <ul className="space-y-1">
          {result.activities.map((item) => {
            const activity = activities.data?.find((candidate) => candidate.id === item.encounterActivityId)
            const matchedLine = lineNumber(item.authorizationLineId)
            return (
              <li key={item.encounterActivityId} className="flex flex-wrap items-center gap-2">
                <OutcomeBadge value={item.outcome} />
                <span className="text-slate-700">{activity ? <ActivityName activity={activity} /> : 'Activity'}</span>
                {matchedLine !== null && <span className="text-xs text-slate-500">line {matchedLine}</span>}
                {item.candidateAuthorizationLineIds.length > 1 && (
                  <span className="text-xs text-slate-500">{item.candidateAuthorizationLineIds.length} candidate lines</span>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {result.lineUtilization.length > 0 && (
        <ul className="space-y-0.5 border-t border-slate-200 pt-2 text-xs text-slate-600">
          {result.lineUtilization.map((usage) => (
            <li key={usage.authorizationLineId}>
              Line {lineNumber(usage.authorizationLineId) ?? '?'}: matched qty {usage.matchedQty} of {usage.approvedQty ?? 'not recorded'} ·{' '}
              {usage.quantityOutcome}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="text-xs text-[var(--sbn-accent)] hover:underline" onClick={() => scope.refetch()} disabled={scope.isFetching}>
        {scope.isFetching ? 'Evaluating...' : 'Evaluate again'}
      </button>
    </div>
  )
}

export function AuthorizationVersionDetail({ version, encounterId }: { version: PriorAuthorizationVersion; encounterId: string }) {
  const { can } = usePermission()
  const lines = useAuthorizationLines(version.id, can('authorizationLine.read'))
  const [evaluating, setEvaluating] = useState(false)

  return (
    <li className="space-y-3 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-950">Version {version.version}</span>
        <span className="text-xs text-slate-500">{version.versionKind}</span>
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{version.status}</span>
        <span className="ml-auto text-xs text-slate-500">Recorded {formatInstant(version.createdAt)}</span>
      </div>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Reference" value={version.authorizationReference} />
        <DetailItem label="Responded at" value={version.respondedAt ? formatInstant(version.respondedAt) : null} />
        <DetailItem label="Valid from" value={version.validFrom ? formatDateOnly(version.validFrom) : null} />
        <DetailItem label="Valid through" value={version.validThrough ? formatDateOnly(version.validThrough) : null} />
      </dl>
      {version.evidenceLinks.length > 0 && (
        <ul className="space-y-0.5 text-xs text-slate-600">
          {version.evidenceLinks.map((link) => (
            <li key={link.id}>
              <span className="font-medium">{link.role}</span> · <EvidenceVersionLabel versionId={link.evidenceArtifactVersionId} />
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Authorized scope</h4>
          <div className="flex gap-2">
            {lines.data && lines.data.length === 0 && (
              <PermissionGate permission="authorizationLine.create">
                <AuthorizationLinesDialog versionId={version.id} trigger={<Button className={secondaryButton}>Capture authorized scope</Button>} />
              </PermissionGate>
            )}
            {lines.data && lines.data.length > 0 && !evaluating && (
              <PermissionGate permission="authorizationLine.evaluate">
                <Button type="button" className={secondaryButton} onClick={() => setEvaluating(true)}>
                  Evaluate recorded scope
                </Button>
              </PermissionGate>
            )}
          </div>
        </div>
        {!can('authorizationLine.read') && <p className="text-xs text-slate-500">Authorized scope is not available to you.</p>}
        {can('authorizationLine.read') && lines.isPending && <Skeleton className="h-10 w-full" />}
        {lines.isError && !lines.data && <p className="text-xs text-red-700">Authorized scope could not be loaded.</p>}
        {lines.data && lines.data.length === 0 && <p className="text-xs text-slate-500">No line scope captured for this version.</p>}
        {lines.data && lines.data.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">#</th>
                  <th scope="col" className="px-3 py-2 font-medium">Service / procedure</th>
                  <th scope="col" className="px-3 py-2 font-medium">Requested</th>
                  <th scope="col" className="px-3 py-2 font-medium">Approved</th>
                  <th scope="col" className="px-3 py-2 font-medium">Unit</th>
                  <th scope="col" className="px-3 py-2 font-medium">Approved dates</th>
                  <th scope="col" className="px-3 py-2 font-medium">Line status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {lines.data.map((line) => (
                  <LineRow key={line.id} line={line} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {evaluating && lines.data && <ScopeResult versionId={version.id} lines={lines.data} encounterId={encounterId} />}
      </div>
    </li>
  )
}
