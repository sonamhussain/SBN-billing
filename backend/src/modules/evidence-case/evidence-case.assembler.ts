import { createHash } from 'node:crypto'
import {
  CASE_CLASSIFICATION_CONTRACT,
  CASE_CONTRACT_VERSION,
  CASE_READINESS_CONTRACT,
  type AssemblerResult,
  type AssemblyCode,
  type AssemblyInput,
  type CaseItem,
} from './evidence-case.types.ts'

// A7.4 §5 — the one pure, deterministic case assembler and its canonical manifest. It reads the owners' stored facts
// and never re-runs the A7.2 classifier, recomputes its fingerprint or re-derives an A7.3 readiness. No clock, locale,
// time zone, environment, database, network, randomness or money is read: the same facts give the same bytes.
//
// Fail closed (a provenance conflict, nothing assembled) when a link is broken or contradictory: a duplicate source,
// a classification of another source or contract, more than one accepted classification, a readiness of another
// classification, source or contract, more than one accepted readiness, a readiness without a classification, an
// uncontrolled readiness, or a readiness that contradicts its classification's outcome.

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const compatibleReadiness = new Map([
  ['CLASSIFIED', 'NOT_READY_FOR_ADJUDICATION|EXTERNAL_ADJUDICATION_EVIDENCE_ABSENT'],
  ['NEEDS_REVIEW', 'SOURCE_REQUIRES_REVIEW|CLASSIFICATION_REVIEW_REQUIRED'],
  ['UNSUPPORTED', 'SOURCE_UNSUPPORTED|CLASSIFICATION_UNSUPPORTED'],
])

const conflict = (detail: string): AssemblerResult => ({ ok: false, refusal: 'PROVENANCE_CONFLICT', detail })

export function assembleCase(input: AssemblyInput): AssemblerResult {
  if (!uuidShape.test(input.claimSubmissionId) || !uuidShape.test(input.organizationId)) return conflict('the submission or organization id is not canonical')
  const seen = new Set<string>()
  const items: CaseItem[] = []
  for (const [index, source] of input.sources.entries()) {
    if (!uuidShape.test(source.sourceEvidenceId) || seen.has(source.sourceEvidenceId)) return conflict('a source id is missing, not canonical or repeated')
    seen.add(source.sourceEvidenceId)
    if (source.classifications.some((c) => c.sourceEvidenceId !== source.sourceEvidenceId)) return conflict('a classification belongs to another source')
    if (source.classifications.some((c) => c.contractVersion !== CASE_CLASSIFICATION_CONTRACT)) return conflict('a classification under another contract version cannot be chosen silently')
    if (source.classifications.length > 1) return conflict('more than one accepted classification exists for a source')
    const classification = source.classifications[0]
    if (!classification) {
      if (source.readiness.length > 0) return conflict('a readiness result exists without its classification')
      items.push({ ordinal: index + 1, sourceEvidenceId: source.sourceEvidenceId, classificationId: null, readinessId: null, itemReasonCode: 'SOURCE_ONLY' })
      continue
    }
    if (!uuidShape.test(classification.classificationId)) return conflict('a classification id is not canonical')
    if (source.readiness.some((r) => r.classificationId !== classification.classificationId || r.sourceEvidenceId !== source.sourceEvidenceId)) return conflict('a readiness result belongs to another classification or source')
    if (source.readiness.some((r) => r.contractVersion !== CASE_READINESS_CONTRACT)) return conflict('a readiness result under another contract version cannot be chosen silently')
    if (source.readiness.length > 1) return conflict('more than one accepted readiness result exists for a classification')
    const readiness = source.readiness[0]
    if (!readiness) {
      items.push({ ordinal: index + 1, sourceEvidenceId: source.sourceEvidenceId, classificationId: classification.classificationId, readinessId: null, itemReasonCode: 'CLASSIFIED_NO_READINESS' })
      continue
    }
    if (!uuidShape.test(readiness.readinessId)) return conflict('a readiness id is not canonical')
    const expected = compatibleReadiness.get(classification.normalizationOutcome)
    if (expected === undefined || expected !== `${readiness.readinessCode}|${readiness.reasonCode}`) return conflict('a readiness result contradicts its classification')
    items.push({ ordinal: index + 1, sourceEvidenceId: source.sourceEvidenceId, classificationId: classification.classificationId, readinessId: readiness.readinessId, itemReasonCode: 'LINKED' })
  }
  const itemCount = items.length
  const classifiedCount = items.filter((item) => item.classificationId !== null).length
  const readinessCount = items.filter((item) => item.readinessId !== null).length
  const assemblyCode: AssemblyCode = itemCount === 0 ? 'NO_REVENUE_SOURCES' : readinessCount === itemCount ? 'INVENTORY_COMPLETE' : 'INVENTORY_INCOMPLETE'
  const manifestText = caseManifestText({ claimSubmissionId: input.claimSubmissionId, organizationId: input.organizationId, assemblyCode, sourceCount: itemCount, classifiedCount, readinessCount, itemCount, items })
  return { ok: true, value: { assemblyCode, sourceCount: itemCount, classifiedCount, readinessCount, itemCount, items, manifestText, manifestSha256: sha256Hex(manifestText) } }
}

// §5 — the canonical manifest, as UTF-8 text: "SBN-A7-REVENUE-CASE-1\n", then one "name=value\n" line each for
// contract, claimSubmissionId, organizationId, assemblyCode, sourceCount, classifiedCount, readinessCount and
// itemCount, then one "item=<ordinal>|<sourceEvidenceId>|<classificationId or NULL>|<readinessId or NULL>|<reason>\n"
// line per item in ordinal order. Lower-case UUIDs, upper-case controlled tokens, integer counts, an explicit NULL
// marker and no date: the database recomputes the identical text at commit.
export const CASE_MANIFEST_DOMAIN = 'SBN-A7-REVENUE-CASE-1\n'

export type ManifestFields = {
  claimSubmissionId: string
  organizationId: string
  assemblyCode: AssemblyCode
  sourceCount: number
  classifiedCount: number
  readinessCount: number
  itemCount: number
  items: CaseItem[]
}

export function caseManifestText(fields: ManifestFields): string {
  const header = [
    ['contract', CASE_CONTRACT_VERSION],
    ['claimSubmissionId', fields.claimSubmissionId],
    ['organizationId', fields.organizationId],
    ['assemblyCode', fields.assemblyCode],
    ['sourceCount', String(fields.sourceCount)],
    ['classifiedCount', String(fields.classifiedCount)],
    ['readinessCount', String(fields.readinessCount)],
    ['itemCount', String(fields.itemCount)],
  ]
  for (const [name, value] of header) if (/[\n=|]/.test(value)) throw new Error(`manifest field ${name} is not canonical`)
  const lines = header.map(([name, value]) => `${name}=${value}\n`)
  for (const item of [...fields.items].sort((a, b) => a.ordinal - b.ordinal)) {
    const parts = [String(item.ordinal), item.sourceEvidenceId, item.classificationId ?? 'NULL', item.readinessId ?? 'NULL', item.itemReasonCode]
    if (parts.some((part) => /[\n=|]/.test(part))) throw new Error('a manifest item is not canonical')
    lines.push(`item=${parts.join('|')}\n`)
  }
  return CASE_MANIFEST_DOMAIN + lines.join('')
}

export const sha256Hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
