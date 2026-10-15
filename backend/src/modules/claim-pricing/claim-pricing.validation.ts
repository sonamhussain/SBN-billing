import { isPlainObject, type Outcome } from '../claim-line/claim-line.validation.ts'

// A6.3 §9 — a pricing run is requested with an empty body (or none). The tariff version, lines, rates,
// totals, service date, payer, readiness and any override are the server's, so every field is refused by
// name, never by value.
export function validateCreatePricingRunBody(body: unknown): Outcome<null> {
  if (body === undefined || body === null) return { ok: true, value: null }
  if (!isPlainObject(body)) return { ok: false, message: 'the pricing run body must be empty' }
  const keys = Object.keys(body)
  return keys.length === 0 ? { ok: true, value: null } : { ok: false, message: `field(s) not accepted for a pricing run: ${keys.join(', ')}` }
}
