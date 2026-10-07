import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { RemoveConfirm } from '../encounter/RemoveConfirm.tsx'
import { useProcedureCodeName, useServiceName } from '../encounter-lookups/encounter-lookups.queries.ts'
import { useActivityMutations } from './encounter-activity.queries.ts'
import type { EncounterActivity } from './encounter-activity.types.ts'

// FE-03 — the active activities in the backend's display order (never a claim-line order). Quantity and
// modifier codes are shown exactly as recorded. A correction is "remove the recorded activity, then add
// the corrected one"; nothing is edited in place.

function ActivityRow({ activity, onRemove }: { activity: EncounterActivity; onRemove: () => Promise<unknown> }) {
  const service = useServiceName(activity.serviceId)
  const procedure = useProcedureCodeName(activity.procedureCodeId)
  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        {service && <div className="text-slate-950">{service}</div>}
        {procedure && <div className={service ? 'mt-0.5 text-slate-600' : 'text-slate-950'}>{procedure}</div>}
      </td>
      <td className="px-4 py-3 tabular-nums text-slate-950">{activity.quantity}</td>
      <td className="px-4 py-3 text-slate-700">{activity.unitCode ?? <span className="text-slate-400">Not recorded</span>}</td>
      <td className="px-4 py-3 text-slate-700">
        {activity.modifierCodes.length > 0 ? activity.modifierCodes.join(', ') : <span className="text-slate-400">None</span>}
      </td>
      <td className="px-4 py-3 text-right">
        <PermissionGate permission="encounterActivity.update">
          <RemoveConfirm
            subject="activity"
            description="This activity will be removed from the encounter's active activities. The removal is kept in the record's history. To correct it, add the corrected activity afterwards."
            onConfirm={onRemove}
          />
        </PermissionGate>
      </td>
    </tr>
  )
}

export function ActivityList({ encounterId, items }: { encounterId: string; items: EncounterActivity[] }) {
  const { remove } = useActivityMutations(encounterId)

  if (items.length === 0) return <EmptyState title="No services or activities recorded" />

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Service / procedure</th>
            <th scope="col" className="px-4 py-2 font-medium">Qty</th>
            <th scope="col" className="px-4 py-2 font-medium">Unit</th>
            <th scope="col" className="px-4 py-2 font-medium">Modifiers</th>
            <th scope="col" className="px-4 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {items.map((activity) => (
            <ActivityRow key={activity.id} activity={activity} onRemove={() => remove.mutateAsync(activity.id)} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
