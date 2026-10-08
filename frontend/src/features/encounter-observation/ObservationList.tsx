import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { RemoveConfirm } from '../encounter/RemoveConfirm.tsx'
import { useActivityLabel } from '../encounter-activity/activity-label.ts'
import type { EncounterActivity } from '../encounter-activity/encounter-activity.types.ts'
import { useObservationMutations } from './encounter-observation.queries.ts'
import type { EncounterObservation } from './encounter-observation.types.ts'
import { displayValue, valueTypeLabels } from './observation-value.ts'

// FE-03 — the active structured facts in the backend's display order. Each shows its key, type, exact
// value and, when anchored, the activity it is about. A correction is remove + add.

function ActivityLink({ activity }: { activity: EncounterActivity }) {
  return <>{useActivityLabel(activity)}</>
}

function linkCell(observation: EncounterObservation, activities: EncounterActivity[] | undefined) {
  if (observation.encounterActivityId === null) return <span className="text-slate-400">Encounter</span>
  const activity = activities?.find((item) => item.id === observation.encounterActivityId)
  if (activity) return <ActivityLink activity={activity} />
  // The anchor is recorded but is not among the active activities this user can currently see.
  return <span className="text-slate-500">Activity not in the active list</span>
}

export function ObservationList({
  encounterId,
  items,
  activities,
}: {
  encounterId: string
  items: EncounterObservation[]
  activities: EncounterActivity[] | undefined
}) {
  const { remove } = useObservationMutations(encounterId)

  if (items.length === 0) return <EmptyState title="No structured facts recorded" />

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Fact key</th>
            <th scope="col" className="px-4 py-2 font-medium">Type</th>
            <th scope="col" className="px-4 py-2 font-medium">Value</th>
            <th scope="col" className="px-4 py-2 font-medium">About</th>
            <th scope="col" className="px-4 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {items.map((observation) => (
            <tr key={observation.id} className="align-top">
              <td className="break-all px-4 py-3 font-medium text-slate-950">{observation.factKey}</td>
              <td className="px-4 py-3 text-slate-700">{valueTypeLabels[observation.value.type]}</td>
              <td className="break-words px-4 py-3 text-slate-950">{displayValue(observation.value)}</td>
              <td className="px-4 py-3 text-slate-700">{linkCell(observation, activities)}</td>
              <td className="px-4 py-3 text-right">
                <PermissionGate permission="encounterObservation.update">
                  <RemoveConfirm
                    subject="fact"
                    description={`The fact "${observation.factKey}" will be removed from this encounter's active facts. The removal is kept in the record's history. To correct it, add the corrected fact afterwards.`}
                    onConfirm={() => remove.mutateAsync(observation.id)}
                  />
                </PermissionGate>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
