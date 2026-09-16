import { readApiError } from '../../shared/api-error.ts'

export type FacilityRegulatoryProfile = {
  id: string
  facilityId: string
  jurisdictionCode: string
  regulatoryAuthorityCode: string
  effectiveFrom: string
  effectiveTo: string | null
  status: string
  createdAt: string
  updatedAt: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function createFacilityRegulatoryProfile(
  facilityId: string,
  jurisdictionCode: string,
  regulatoryAuthorityCode: string,
  effectiveFrom: string,
  effectiveTo: string,
): Promise<FacilityRegulatoryProfile> {
  return handle(
    await fetch(`/api/facilities/${facilityId}/regulatory-profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jurisdictionCode, regulatoryAuthorityCode, effectiveFrom, effectiveTo: effectiveTo || null }),
    }),
  )
}

export async function loadFacilityRegulatoryProfiles(facilityId: string): Promise<FacilityRegulatoryProfile[]> {
  const data = await handle<{ items: FacilityRegulatoryProfile[] }>(
    await fetch(`/api/facilities/${facilityId}/regulatory-profiles`),
  )
  return data.items
}

export async function activateFacilityRegulatoryProfile(id: string): Promise<FacilityRegulatoryProfile> {
  return handle(await fetch(`/api/facility-regulatory-profiles/${id}/activate`, { method: 'POST' }))
}
