export type FacilityRegulatoryProfileDto = {
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

export type FacilityRegulatoryProfileListDto = {
  items: FacilityRegulatoryProfileDto[]
}

export type FacilityRegulatoryProfileErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type FacilityRegulatoryProfileResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: FacilityRegulatoryProfileErrorCode; message: string }
