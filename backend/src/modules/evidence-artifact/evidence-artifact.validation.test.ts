import test from 'node:test'
import assert from 'node:assert/strict'
import {
  evidenceAuditSnapshot,
  isEvidenceUuid,
  nextVersionNumber,
  normalizeContentHash,
  normalizeDocumentType,
  normalizeReceivedAt,
  normalizeSourceDate,
  normalizeStorageRef,
  toEvidenceVersionDto,
  validateVersionBody,
} from './evidence-artifact.validation.ts'

// A5.1 — the pure validation rules. Synthetic values only; no database access.

const NOW = new Date('2026-06-20T12:00:00.000Z')
const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const ID = '11111111-1111-4111-8111-111111111111'

const body = (overrides: Record<string, unknown> = {}) => ({
  storageRef: 'synthetic://evidence/A51/initial',
  contentHash: HASH,
  documentType: 'SYNTHETIC_ELIGIBILITY_RESPONSE',
  receivedAt: '2026-06-15T09:30:00.000Z',
  ...overrides,
})

test('an evidence id must be UUID-shaped', () => {
  assert.equal(isEvidenceUuid(ID), true)
  assert.equal(isEvidenceUuid('not-a-uuid'), false)
  assert.equal(isEvidenceUuid(7), false)
  assert.equal(isEvidenceUuid(null), false)
})

// ---------------------------------------------------------------- storageRef

test('storageRef is trimmed and kept exactly as given', () => {
  const outcome = normalizeStorageRef('  synthetic://evidence/A51/x  ')
  assert.equal(outcome.ok && outcome.value, 'synthetic://evidence/A51/x')
})

test('storageRef is opaque: no URL, path or provider shape is required', () => {
  for (const value of ['synthetic://evidence/a/b', 'plain-opaque-token', '../not/parsed/as/a/path', 's3-looking-but-not-parsed', '{"looks":"like json"}']) {
    assert.equal(normalizeStorageRef(value).ok, true, `${value} must be accepted unparsed`)
  }
})

test('a blank, non-string, line-broken or oversize storageRef is rejected', () => {
  assert.equal(normalizeStorageRef('   ').ok, false, 'blank')
  assert.equal(normalizeStorageRef('').ok, false, 'empty')
  assert.equal(normalizeStorageRef(42).ok, false, 'non-string')
  assert.equal(normalizeStorageRef(null).ok, false, 'null')
  assert.equal(normalizeStorageRef('a\nb').ok, false, 'line feed')
  assert.equal(normalizeStorageRef('a\rb').ok, false, 'carriage return')
  assert.equal(normalizeStorageRef('x'.repeat(1025)).ok, false, 'oversize')
  assert.equal(normalizeStorageRef('x'.repeat(1024)).ok, true, 'exactly at the limit')
})

// ---------------------------------------------------------------- contentHash

test('a canonical lowercase digest is accepted unchanged', () => {
  const outcome = normalizeContentHash(HASH)
  assert.equal(outcome.ok && outcome.value, HASH)
})

// §7 — the approved behaviour is trim + lowercase. An uppercase digest names the same bytes, so it
// is normalized rather than refused, and exactly one canonical form is ever stored.
test('an uppercase or padded digest is normalized to the one canonical form', () => {
  const upper = normalizeContentHash(HASH.toUpperCase())
  const padded = normalizeContentHash(`  ${HASH}  `)
  const mixed = normalizeContentHash(HASH.slice(0, 32).toUpperCase() + HASH.slice(32))
  assert.equal(upper.ok && upper.value, HASH, 'uppercase')
  assert.equal(padded.ok && padded.value, HASH, 'padded')
  assert.equal(mixed.ok && mixed.value, HASH, 'mixed case')
})

test('a digest of the wrong length or with a non-hex character is rejected', () => {
  assert.equal(normalizeContentHash(HASH.slice(0, 63)).ok, false, 'too short')
  assert.equal(normalizeContentHash(`${HASH}0`).ok, false, 'too long')
  assert.equal(normalizeContentHash(`${HASH.slice(0, 63)}g`).ok, false, 'non-hex character')
  assert.equal(normalizeContentHash('').ok, false, 'empty')
  assert.equal(normalizeContentHash('   ').ok, false, 'blank')
  assert.equal(normalizeContentHash(42).ok, false, 'non-string')
  assert.equal(normalizeContentHash(`sha256:${HASH}`).ok, false, 'a prefixed form is not canonical')
})

// ---------------------------------------------------------------- documentType

test('documentType is an opaque trimmed label', () => {
  const trimmed = normalizeDocumentType('  SYNTHETIC_X  ')
  assert.equal(trimmed.ok && trimmed.value, 'SYNTHETIC_X')
  // No payer or UAE vocabulary is enforced: this package has no authority to define one.
  for (const value of ['SYNTHETIC_ANYTHING', 'lower case label', 'a', 'x'.repeat(120)]) {
    assert.equal(normalizeDocumentType(value).ok, true, `${value.slice(0, 20)} must be accepted`)
  }
})

test('a blank, line-broken or oversize documentType is rejected', () => {
  assert.equal(normalizeDocumentType('   ').ok, false)
  assert.equal(normalizeDocumentType(42).ok, false)
  assert.equal(normalizeDocumentType('a\nb').ok, false)
  assert.equal(normalizeDocumentType('x'.repeat(121)).ok, false)
})

// ---------------------------------------------------------------- sourceDate

test('an absent or null sourceDate means unknown, which is a real answer', () => {
  const absent = normalizeSourceDate(undefined, NOW)
  const explicitNull = normalizeSourceDate(null, NOW)
  assert.equal(absent.ok && absent.value, null)
  assert.equal(explicitNull.ok && explicitNull.value, null)
})

test('sourceDate is a strict calendar date, never a timestamp', () => {
  assert.equal(normalizeSourceDate('2026-06-15', NOW).ok, true)
  assert.equal(normalizeSourceDate('2026-02-31', NOW).ok, false, 'an impossible date')
  assert.equal(normalizeSourceDate('2026-06-15T09:30:00.000Z', NOW).ok, false, 'a timestamp')
  assert.equal(normalizeSourceDate('15/06/2026', NOW).ok, false, 'a non-ISO date')
  assert.equal(normalizeSourceDate(42, NOW).ok, false, 'non-string')
})

test('a future sourceDate is rejected, and today is allowed', () => {
  assert.equal(normalizeSourceDate('2026-06-21', NOW).ok, false, 'tomorrow')
  assert.equal(normalizeSourceDate('2026-06-20', NOW).ok, true, 'today')
  assert.equal(normalizeSourceDate('2019-01-01', NOW).ok, true, 'a historical source date is legitimate')
})

// ---------------------------------------------------------------- receivedAt

test('receivedAt is a strict ISO-8601 instant', () => {
  assert.equal(normalizeReceivedAt('2026-06-15T09:30:00.000Z', NOW).ok, true)
  assert.equal(normalizeReceivedAt('2026-06-15', NOW).ok, false, 'a date-only value is not an instant')
  assert.equal(normalizeReceivedAt('not-a-date', NOW).ok, false)
  assert.equal(normalizeReceivedAt(undefined, NOW).ok, false, 'required')
  assert.equal(normalizeReceivedAt(42, NOW).ok, false, 'non-string')
})

// A caller's clock may sit seconds ahead of this server's without being wrong, so a small allowance
// is granted; anything materially ahead has not happened yet and is refused.
test('a materially future receivedAt is rejected, while a small clock skew is tolerated', () => {
  const skew = new Date(NOW.getTime() + 60 * 1000).toISOString()
  const ahead = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString()
  assert.equal(normalizeReceivedAt(skew, NOW).ok, true, 'one minute ahead is clock skew')
  assert.equal(normalizeReceivedAt(ahead, NOW).ok, false, 'an hour ahead has not happened yet')
})

// ---------------------------------------------------------------- the whole body

test('a valid body normalizes every field', () => {
  const outcome = validateVersionBody(body({ sourceDate: '2026-06-15', contentHash: HASH.toUpperCase() }), NOW)
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.ok && outcome.value, {
    storageRef: 'synthetic://evidence/A51/initial',
    contentHash: HASH,
    documentType: 'SYNTHETIC_ELIGIBILITY_RESPONSE',
    sourceDate: new Date('2026-06-15T00:00:00.000Z'),
    receivedAt: new Date('2026-06-15T09:30:00.000Z'),
  })
})

test('a body may omit sourceDate entirely', () => {
  const outcome = validateVersionBody(body(), NOW)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.value.sourceDate, null)
})

// The server owns the identity, the number, the author and every timestamp. A caller who supplies
// one of them is trying to write history rather than record a representation.
test('a body carrying a server-owned field is rejected, and the message names it', () => {
  for (const field of ['id', 'version', 'evidenceArtifactId', 'organizationId', 'createdByUserId', 'createdAt']) {
    const outcome = validateVersionBody(body({ [field]: 'x' }), NOW)
    assert.equal(outcome.ok, false, `${field} must be refused`)
    assert.equal(outcome.ok === false && outcome.message.includes(field), true, `the message must name ${field}`)
  }
})

test('an unknown field is rejected and named', () => {
  const outcome = validateVersionBody(body({ eligibilityStatus: 'ELIGIBLE' }), NOW)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.message.includes('eligibilityStatus'), true)
})

test('a body that is not a plain object is rejected', () => {
  assert.equal(validateVersionBody(null, NOW).ok, false)
  assert.equal(validateVersionBody(undefined, NOW).ok, false)
  assert.equal(validateVersionBody([body()], NOW).ok, false)
  assert.equal(validateVersionBody('storageRef=x', NOW).ok, false)
  assert.equal(validateVersionBody({}, NOW).ok, false, 'an empty body supplies no representation')
})

// A validation message names the field that was wrong; it never repeats the value back, because an
// error response is one of the easiest places for evidence metadata to escape into a log.
test('a validation message never echoes the submitted evidence values', () => {
  const secretRef = 'synthetic://evidence/secret-locator-value'
  const outcome = validateVersionBody(body({ storageRef: secretRef, contentHash: 'too-short' }), NOW)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false && outcome.message.includes(secretRef), false, 'the storage reference must not appear')
  assert.equal(outcome.ok === false && outcome.message.includes('too-short'), false, 'the submitted hash must not appear')
})

// ---------------------------------------------------------------- numbering

test('version numbering starts at 1 and always advances by one', () => {
  assert.equal(nextVersionNumber(null), 1, 'the first version of a new artifact')
  assert.equal(nextVersionNumber(1), 2)
  assert.equal(nextVersionNumber(7), 8)
})

// ---------------------------------------------------------------- DTO and audit

test('the version DTO exposes metadata and a date-only source date', () => {
  const dto = toEvidenceVersionDto({
    id: ID,
    evidenceArtifactId: ID,
    version: 2,
    storageRef: 'synthetic://evidence/x',
    contentHash: HASH,
    documentType: 'SYNTHETIC_X',
    sourceDate: new Date('2026-06-15T00:00:00.000Z'),
    receivedAt: new Date('2026-06-15T09:30:00.000Z'),
    createdByUserId: ID,
    createdAt: new Date('2026-06-15T09:31:00.000Z'),
  })
  assert.equal(dto.sourceDate, '2026-06-15')
  assert.equal(dto.receivedAt, '2026-06-15T09:30:00.000Z')
  assert.equal(dto.version, 2)
  assert.equal('bytes' in dto, false, 'no evidence content is returned')
  assert.equal('downloadUrl' in dto, false, 'no signed download link is returned')
})

test('an unknown source date stays null in the DTO', () => {
  const dto = toEvidenceVersionDto({
    id: ID,
    evidenceArtifactId: ID,
    version: 1,
    storageRef: 'synthetic://evidence/x',
    contentHash: HASH,
    documentType: 'SYNTHETIC_X',
    sourceDate: null,
    receivedAt: new Date('2026-06-15T09:30:00.000Z'),
    createdByUserId: ID,
    createdAt: new Date('2026-06-15T09:31:00.000Z'),
  })
  assert.equal(dto.sourceDate, null)
})

// §13 — evidence metadata can itself reveal clinical and insurance workflow, so the audit trail
// records that something happened and to which row, and nothing about what it contained.
test('the audit snapshot carries identifiers and timestamps only', () => {
  const snapshot = evidenceAuditSnapshot({
    id: ID,
    version: 2,
    evidenceArtifactId: ID,
    createdAt: new Date('2026-06-15T09:31:00.000Z'),
  })
  assert.deepEqual(Object.keys(snapshot).sort(), ['createdAt', 'evidenceArtifactId', 'id', 'version'])
  for (const forbidden of ['storageRef', 'contentHash', 'documentType', 'sourceDate', 'receivedAt']) {
    assert.equal(forbidden in snapshot, false, `${forbidden} must never reach the audit trail`)
  }
})
