export type TariffScheduleDto = {
  id: string
  providerContractId: string
  tariffKey: string
  displayName: string
  createdAt: string
  updatedAt: string
}

export type TariffScheduleListDto = {
  items: TariffScheduleDto[]
}

export type TariffScheduleVersionDto = {
  id: string
  tariffScheduleId: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export type TariffScheduleVersionListDto = {
  items: TariffScheduleVersionDto[]
}

export type TariffScheduleErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'FORBIDDEN'

export type TariffScheduleResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: TariffScheduleErrorCode; message: string }
