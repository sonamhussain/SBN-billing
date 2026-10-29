import { createHash } from 'node:crypto'
import { EXCEPTION_INTAKE_CONTRACT_VERSION, type IdentityParts } from './exception-intake.types.ts'

// A8.1 §4 — the deterministic dedupe identity of an exception intake: SHA-256 over one canonical preimage of the
// organization, Claim, source kind, source record, source contract and reason. Lowercase canonical UUIDs and
// uppercase controlled codes only, one `name=value` line each, so two different inputs can never share a preimage
// (no part may contain a line break or '='). No PHI, payload or free text ever enters it. The database insert guard
// recomputes the same digest from the stored columns.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const codeShape = /^[A-Z0-9][A-Z0-9_-]*$/

export function identityPreimage(parts: IdentityParts): string {
  const fields: [string, string, RegExp][] = [
    ['organization', parts.organizationId, uuidShape],
    ['claim', parts.claimId, uuidShape],
    ['sourceKind', parts.sourceKind, codeShape],
    ['sourceRecord', parts.sourceRecordId, uuidShape],
    ['sourceContract', parts.sourceContractVersion, codeShape],
    ['reason', parts.exceptionReasonCode, codeShape],
  ]
  for (const [name, value, shape] of fields) if (typeof value !== 'string' || !shape.test(value)) throw new Error(`identity part ${name} is not canonical`)
  return `${EXCEPTION_INTAKE_CONTRACT_VERSION}\n${fields.map(([name, value]) => `${name}=${value}\n`).join('')}`
}

export const identityKeyOf = (parts: IdentityParts): string => createHash('sha256').update(identityPreimage(parts), 'utf8').digest('hex')
