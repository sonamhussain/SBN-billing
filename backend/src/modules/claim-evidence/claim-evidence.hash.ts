import { createHash } from 'node:crypto'
import type { FreezeIdentity } from './claim-evidence.types.ts'

// A6.7 §4 — the digests of a freeze. Every digest is SHA-256 over exact bytes; the seal is computed over the
// 32-byte digests and the 16-byte ids themselves, never over printed hex or JSON of ORM objects. The
// database recomputes the same seal before it stores a package.

export const SEAL_DOMAIN = 'SBN-A6-SUBMISSION-1\n'

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const hex64Shape = /^[0-9a-f]{64}$/

export class SealInputError extends Error {}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// The 16 RFC 4122 bytes of a lowercase UUID (what PostgreSQL's uuid_send returns).
export function uuidBytes(value: string): Buffer {
  if (!uuidShape.test(value)) throw new SealInputError('seal identity must be lowercase UUIDs')
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

function digestBytes(value: string): Buffer {
  if (!hex64Shape.test(value)) throw new SealInputError('seal digests must be lowercase SHA-256 hex')
  return Buffer.from(value, 'hex')
}

// A6-SUBMISSION-1 seal:
//   SHA-256( UTF-8("SBN-A6-SUBMISSION-1\n") || payload digest (32) || manifest digest (32)
//            || claim id (16) || draft assessment id (16) || approval review event id (16) || pricing run id (16) )
export function packageSealSha256(payloadSha256: string, manifestSha256: string, identity: FreezeIdentity): string {
  return sha256Hex(
    Buffer.concat([
      Buffer.from(SEAL_DOMAIN, 'utf8'),
      digestBytes(payloadSha256),
      digestBytes(manifestSha256),
      uuidBytes(identity.claimId),
      uuidBytes(identity.draftAssessmentId),
      uuidBytes(identity.approvalReviewEventId),
      uuidBytes(identity.pricingRunId),
    ]),
  )
}
