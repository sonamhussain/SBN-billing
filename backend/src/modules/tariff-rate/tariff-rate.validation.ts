import { isClaimStructureUuid, isPlainObject, refuseForeignKeys, type Outcome } from '../claim-line/claim-line.validation.ts'
import {
  createRateBodyFields,
  rateSelectorKinds,
  serverOwnedRateFields,
  supportedCurrencyMinorUnits,
  type RateSelectorKind,
  type TariffRateCreateInput,
} from './tariff-rate.types.ts'

// A6.3 — the pure rate rules: body validation, the canonical modifier signature and the exact amount
// shape. No database access lives here, and no amount ever passes through a JavaScript number.

export const isTariffRateUuid = (value: unknown): value is string => isClaimStructureUuid(value)

const isRateSelectorKind = (value: unknown): value is RateSelectorKind => typeof value === 'string' && (rateSelectorKinds as readonly string[]).includes(value)

// §6 — a non-negative decimal string with at most 14 integer and 4 fractional digits. A number is refused:
// it may already have lost precision before it reached the server.
const amountShape = /^\d{1,14}(\.\d{1,4})?$/

// §4 — trimmed, non-blank, unique codes in canonical (code-unit) order. The empty list is a real
// signature. Codes are compared exactly; case is kept and nothing is treated as equivalent.
export function canonicalModifierSignature(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function validateCreateRateBody(body: unknown): Outcome<TariffRateCreateInput> {
  if (!isPlainObject(body)) return { ok: false, message: 'a tariff rate body is required' }
  const refused = refuseForeignKeys(body, createRateBodyFields, serverOwnedRateFields)
  if (refused) return { ok: false, message: refused }

  if (!isRateSelectorKind(body.selectorKind)) return { ok: false, message: `selectorKind must be one of ${rateSelectorKinds.join(', ')}` }
  const serviceId = body.serviceId ?? null
  const procedureCodeId = body.procedureCodeId ?? null
  if (body.selectorKind === 'SERVICE') {
    if (!isTariffRateUuid(serviceId) || procedureCodeId !== null) return { ok: false, message: 'a SERVICE rate needs exactly a serviceId UUID and no procedureCodeId' }
  } else if (!isTariffRateUuid(procedureCodeId) || serviceId !== null) {
    return { ok: false, message: 'a PROCEDURE_CODE rate needs exactly a procedureCodeId UUID and no serviceId' }
  }

  let unitCodeKey: string | null = null
  if (body.unitCodeKey !== undefined && body.unitCodeKey !== null) {
    if (typeof body.unitCodeKey !== 'string' || body.unitCodeKey.trim() === '') return { ok: false, message: 'unitCodeKey must be a non-blank string, or null for an activity recorded without a unit' }
    unitCodeKey = body.unitCodeKey.trim()
  }

  if (!Array.isArray(body.modifierCodes)) return { ok: false, message: 'modifierCodes must be an array of strings (empty for no modifiers)' }
  const codes: string[] = []
  for (const item of body.modifierCodes) {
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, message: 'modifierCodes must contain non-blank strings only' }
    codes.push(item.trim())
  }
  if (new Set(codes).size !== codes.length) return { ok: false, message: 'modifierCodes must not contain the same code twice' }

  if (typeof body.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(body.currencyCode)) return { ok: false, message: 'currencyCode must be an uppercase ISO 4217 code' }
  if (!(body.currencyCode in supportedCurrencyMinorUnits)) return { ok: false, message: `currency ${body.currencyCode} is not configured for pricing` }

  if (typeof body.unitTariffAmount !== 'string' || !amountShape.test(body.unitTariffAmount))
    return { ok: false, message: 'unitTariffAmount must be a non-negative decimal string with at most 14 integer and 4 fractional digits' }

  return {
    ok: true,
    value: {
      selectorKind: body.selectorKind,
      serviceId: body.selectorKind === 'SERVICE' ? (serviceId as string) : null,
      procedureCodeId: body.selectorKind === 'PROCEDURE_CODE' ? (procedureCodeId as string) : null,
      unitCodeKey,
      modifierSignature: canonicalModifierSignature(codes),
      currencyCode: body.currencyCode,
      unitTariffAmount: body.unitTariffAmount,
    },
  }
}

// Retire: an empty object (an absent body is treated as empty). Anything else is refused by name.
export function validateRetireBody(body: unknown): Outcome<null> {
  if (body === undefined || body === null) return { ok: true, value: null }
  if (!isPlainObject(body)) return { ok: false, message: 'a retire body must be an empty object' }
  const keys = Object.keys(body)
  return keys.length === 0 ? { ok: true, value: null } : { ok: false, message: `field(s) not accepted for retirement: ${keys.join(', ')}` }
}
