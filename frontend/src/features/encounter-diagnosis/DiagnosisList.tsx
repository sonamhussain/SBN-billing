import { ArrowDown, ArrowUp } from 'lucide-react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { Alert } from '../../shared/ui/Alert.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { RemoveConfirm } from '../encounter/RemoveConfirm.tsx'
import { useDiagnosisMutations } from './encounter-diagnosis.queries.ts'
import type { EncounterDiagnosis } from './encounter-diagnosis.types.ts'

// FE-03 — the active diagnoses in the backend's sequence. The number is a position only: nothing here
// calls a diagnosis primary or secondary. Up/Down sends the complete active ID set in its new order;
// removed rows are not shown here.

function moved(items: EncounterDiagnosis[], index: number, offset: -1 | 1) {
  const ids = items.map((item) => item.id)
  const target = index + offset
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  return ids
}

const iconButton =
  'rounded p-1.5 text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-30'

export function DiagnosisList({ encounterId, items }: { encounterId: string; items: EncounterDiagnosis[] }) {
  const { reorder, remove } = useDiagnosisMutations(encounterId)

  if (items.length === 0) return <EmptyState title="No diagnoses recorded" />

  return (
    <div className="space-y-2">
      {reorder.isError && <Alert tone="danger">{describeSaveError(reorder.error, 'The diagnosis order')}</Alert>}
      <ol className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
        {items.map((diagnosis, index) => (
          <li key={diagnosis.id} className="flex items-center gap-4 px-4 py-3 text-sm">
            <span className="w-6 shrink-0 text-right tabular-nums text-slate-500">{diagnosis.sequence}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium text-slate-950">{diagnosis.diagnosisCode.code}</span>
              <span className="text-slate-600"> — {diagnosis.diagnosisCode.displayName}</span>
            </span>
            <PermissionGate permission="encounterDiagnosis.update">
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  className={iconButton}
                  aria-label={`Move ${diagnosis.diagnosisCode.code} up`}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => reorder.mutate(moved(items, index, -1))}
                >
                  <ArrowUp aria-hidden="true" size={15} />
                </button>
                <button
                  type="button"
                  className={iconButton}
                  aria-label={`Move ${diagnosis.diagnosisCode.code} down`}
                  disabled={index === items.length - 1 || reorder.isPending}
                  onClick={() => reorder.mutate(moved(items, index, 1))}
                >
                  <ArrowDown aria-hidden="true" size={15} />
                </button>
                <RemoveConfirm
                  subject="diagnosis"
                  description={`${diagnosis.diagnosisCode.code} will be removed from this encounter's active diagnoses. The removal is kept in the record's history.`}
                  onConfirm={() => remove.mutateAsync(diagnosis.id)}
                />
              </span>
            </PermissionGate>
          </li>
        ))}
      </ol>
    </div>
  )
}
