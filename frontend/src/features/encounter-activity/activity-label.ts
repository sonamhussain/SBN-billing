import { useProcedureCodeName, useServiceName } from '../encounter-lookups/encounter-lookups.queries.ts'
import type { EncounterActivity } from './encounter-activity.types.ts'

// The service and procedure names of one recorded activity, e.g. to label an observation's activity
// link. A display aid only; it never maps one identity onto the other.
export function useActivityLabel(activity: EncounterActivity) {
  const service = useServiceName(activity.serviceId)
  const procedure = useProcedureCodeName(activity.procedureCodeId)
  return [service, procedure].filter((label) => label !== null).join(' · ')
}
