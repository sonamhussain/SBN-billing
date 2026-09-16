export type ReferenceDatasetDto = {
  id: string
  datasetKey: string
  displayName: string
  jurisdictionCode: string
  authorityCode: string
  createdAt: string
  updatedAt: string
}

export type ReferenceDatasetListDto = {
  items: ReferenceDatasetDto[]
}

export type ReferenceDatasetVersionDto = {
  id: string
  datasetId: string
  sourceVersionId: string | null
  version: string
  retrievedAt: string
  publicationDate: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  contentHash: string
  validationStatus: string
  activationStatus: string
  activatedAt: string | null
  supersededAt: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export type ReferenceDatasetVersionListDto = {
  items: ReferenceDatasetVersionDto[]
}

export type ReferenceDatasetErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND'

export type ReferenceDatasetResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ReferenceDatasetErrorCode; message: string }
