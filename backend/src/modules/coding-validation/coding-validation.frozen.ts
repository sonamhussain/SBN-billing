import { codingSectionOf, PAYLOAD_SCHEMA_VERSION_V2, type RecordedReceipt } from '../claim-payload/claim-payload.v2.ts'
import type { CanonicalClaimPayloadV1 } from '../claim-payload/claim-payload.types.ts'

// CRG-01 Checkpoint B, H5 (review F05): the frozen coding section of an A6-PAYLOAD-2 freeze is verified entry by entry
// against the run's immutable receipts, never by receipt identifiers alone. The section the composer would bind from
// these receipts is rebuilt with the composer's own pure `codingSectionOf` over the FROZEN diagnoses and lines, and
// must equal the frozen section exactly — each entry's claim diagnosis or line, its encounter target, receipt, code
// system, edition, membership and source-row hash, in the frozen order. Each receipt must also be of the entry's
// subject kind and name the frozen diagnosis or procedure master, and every receipt is bound exactly once. Pure: it
// reads no database, clock or current state; the receipts given are the ones H1–H4 verified as recorded.

export type FrozenReceiptFacts = {
  receiptId: string
  subjectKind: string
  targetId: string
  masterCodeId: string
  decisionCode: string
  codeSystem: string | null
  referenceDatasetVersionId: string | null
  membershipId: string | null
  sourceRowSha256: string | null
}

export type FrozenCodingVerdict = { ok: true } | { ok: false; detail: string }

const CODING_KEYS = ['manifestSha256', 'diagnoses', 'lines']
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export function verifyFrozenCoding(bytes: Uint8Array, manifestSha256: string, receipts: readonly FrozenReceiptFacts[]): FrozenCodingVerdict {
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    return { ok: false, detail: 'the frozen bytes are not a canonical payload' }
  }
  if (!isRecord(payload) || payload.schemaVersion !== PAYLOAD_SCHEMA_VERSION_V2 || !Array.isArray(payload.diagnoses) || !Array.isArray(payload.lines))
    return { ok: false, detail: `the frozen payload is not ${PAYLOAD_SCHEMA_VERSION_V2}` }
  const coding = payload.coding
  if (!isRecord(coding) || JSON.stringify(Object.keys(coding)) !== JSON.stringify(CODING_KEYS) || !Array.isArray(coding.diagnoses) || !Array.isArray(coding.lines))
    return { ok: false, detail: 'the frozen payload has no exact coding section' }
  if (coding.manifestSha256 !== manifestSha256) return { ok: false, detail: "the frozen coding section names another manifest than the run's" }

  // One receipt per target and per identifier, as recorded.
  const byTarget = new Map<string, RecordedReceipt>()
  const byId = new Map<string, FrozenReceiptFacts>()
  for (const r of receipts) {
    if (byTarget.has(r.targetId) || byId.has(r.receiptId)) return { ok: false, detail: 'two recorded receipts share a target or an identifier' }
    byTarget.set(r.targetId, { receiptId: r.receiptId, decisionCode: r.decisionCode, codeSystem: r.codeSystem, referenceDatasetVersionId: r.referenceDatasetVersionId, membershipId: r.membershipId, sourceRowSha256: r.sourceRowSha256 })
    byId.set(r.receiptId, r)
  }

  // The complete section, rebuilt from the frozen diagnoses and lines and the recorded receipts, equals the frozen one.
  const expected = codingSectionOf(payload as unknown as CanonicalClaimPayloadV1, manifestSha256, byTarget)
  if (!expected.ok) return { ok: false, detail: `the frozen claim does not bind to the recorded receipts: ${expected.detail}` }
  if (JSON.stringify(expected.value) !== JSON.stringify(coding)) return { ok: false, detail: 'a frozen coding entry differs from its recorded receipt (target, code system, edition, membership, source-row hash, receipt or order)' }

  // Each receipt is of the entry's kind and names the frozen diagnosis or procedure master; every receipt bound once.
  const frozenDiagnoses = new Map((payload.diagnoses as Record<string, unknown>[]).map((d) => [d.claimDiagnosisId, d]))
  const frozenLines = new Map((payload.lines as Record<string, unknown>[]).map((l) => [l.claimLineId, l]))
  const bound = new Set<string>()
  for (const entry of expected.value.diagnoses) {
    const receipt = byId.get(entry.receiptId)
    if (!receipt || receipt.subjectKind !== 'DIAGNOSIS' || receipt.masterCodeId !== frozenDiagnoses.get(entry.claimDiagnosisId)?.diagnosisCodeId)
      return { ok: false, detail: 'a frozen diagnosis is bound to a receipt of another kind or another diagnosis master' }
    bound.add(entry.receiptId)
  }
  for (const entry of expected.value.lines) {
    const receipt = byId.get(entry.receiptId)
    if (!receipt || receipt.subjectKind !== 'PROCEDURE' || receipt.masterCodeId !== frozenLines.get(entry.claimLineId)?.procedureCodeId)
      return { ok: false, detail: 'a frozen claim line is bound to a receipt of another kind or another procedure master' }
    bound.add(entry.receiptId)
  }
  if (bound.size !== expected.value.diagnoses.length + expected.value.lines.length || bound.size !== receipts.length) return { ok: false, detail: 'a recorded receipt is not bound exactly once by the frozen coding section' }
  return { ok: true }
}
