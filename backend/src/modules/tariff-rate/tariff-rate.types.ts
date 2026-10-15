// A6.3 — TariffRate answers one question: under this exact tariff version, what is the explicit tariff
// amount per unit for one exact source identity (a Service or a ProcedureCode), one exact unit and one
// canonical modifier set? It never states payer Net, contracted reimbursement or patient responsibility,
// and it is written only while the version is UNVERIFIED.

export const RATE_CONTRACT_VERSION = 'A6-RATE-1'

export const rateSelectorKinds = ['SERVICE', 'PROCEDURE_CODE'] as const
export type RateSelectorKind = (typeof rateSelectorKinds)[number]

// §6 — the currencies this module may price in, with their minor units, as an explicit typed table. Only
// AED (2 minor units) is enabled for the Dubai path; any other code is refused until it is configured
// here deliberately. Never inferred from ISO text and never a platform-wide currency switch.
export const supportedCurrencyMinorUnits: Readonly<Record<string, number>> = { AED: 2 }

export type TariffRateDto = {
  id: string
  tariffScheduleVersionId: string
  selectorKind: string
  serviceId: string | null
  procedureCodeId: string | null
  unitCodeKey: string | null
  modifierCodes: string[]
  currencyCode: string
  // Canonical 4-decimal string; never a JavaScript binary float.
  unitTariffAmount: string
  rateContractVersion: string
  removedAt: string | null
  createdByUserId: string
  createdAt: string
}

export type TariffRateErrorCode = 'VALIDATION_ERROR' | 'NOT_FOUND' | 'RATE_VERSION_LOCKED' | 'RATE_DUPLICATE' | 'RATE_ALREADY_RETIRED'

export type TariffRateResult<T> = { ok: true; value: T } | { ok: false; code: TariffRateErrorCode; message: string }

export type TariffRateCreateInput = {
  selectorKind: RateSelectorKind
  serviceId: string | null
  procedureCodeId: string | null
  unitCodeKey: string | null
  modifierSignature: string[]
  currencyCode: string
  unitTariffAmount: string
}

// §9 — the only fields a client may supply; everything else is server-owned and refused by name.
export const createRateBodyFields = ['selectorKind', 'serviceId', 'procedureCodeId', 'unitCodeKey', 'modifierCodes', 'currencyCode', 'unitTariffAmount'] as const
export const serverOwnedRateFields = ['id', 'tariffScheduleVersionId', 'rateContractVersion', 'removedAt', 'createdByUserId', 'createdAt', 'modifierSignature'] as const
