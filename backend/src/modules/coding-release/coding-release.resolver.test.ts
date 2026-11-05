import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { membershipFingerprint, parseReleaseArtifact } from './coding-release.artifact.ts'
import { canonicalCode, decideCode, diagnosisIdentity, procedureIdentity, resolveEdition } from './coding-release.resolver.ts'
import type { CodeSystem, EditionFacts, LifecycleFact, MembershipBasis, ResolutionScope, RightsStatus } from './coding-release.types.ts'

// CRG-01 FINAL Checkpoint A — the resolver, exhaustively, on synthetic editions A (2021) and B (2024). Synthetic
// values only; the 2027 boundary is a synthetic fixture, never verified law.

const approvedRights: Partial<Record<CodeSystem, RightsStatus>> = { 'ICD-10-CM': 'APPROVED', CPT: 'APPROVED' }
const scope = (serviceDate: string, jurisdictionCode = 'AE-DU', authorityCode = 'SYN', rights = approvedRights): ResolutionScope => ({ serviceDate, jurisdictionCode, authorityCode, rights })
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const activated: LifecycleFact[] = [
  { action: 'VALIDATE', previousActivationStatus: 'INACTIVE', nextActivationStatus: 'INACTIVE', nextValidationStatus: 'VALIDATED' },
  { action: 'ACTIVATE', previousActivationStatus: 'INACTIVE', nextActivationStatus: 'ACTIVE', nextValidationStatus: 'VALIDATED' },
]
const superseded: LifecycleFact[] = [...activated, { action: 'SUPERSEDE', previousActivationStatus: 'ACTIVE', nextActivationStatus: 'SUPERSEDED', nextValidationStatus: 'VALIDATED' }]
const retired: LifecycleFact[] = [...superseded, { action: 'RETIRE', previousActivationStatus: 'SUPERSEDED', nextActivationStatus: 'RETIRED', nextValidationStatus: 'VALIDATED' }]
const edition = (n: number, o: Partial<EditionFacts> = {}): EditionFacts => ({
  datasetVersionId: id(n), datasetId: id(100), datasetJurisdictionCode: 'AE-DU', datasetAuthorityCode: 'SYN', mappingCodeSystem: 'ICD-10-CM', mappingPurpose: 'CLAIM_CODING',
  mappingJurisdictionCode: 'AE-DU', mappingAuthorityCode: 'SYN', version: `v${n}`, effectiveFrom: '2021-01-01', effectiveTo: null, validationStatus: 'VALIDATED', activationStatus: 'ACTIVE',
  contentHash: String(n % 10).repeat(64), sourceVersionId: null, lifecycle: activated, importId: id(300 + n), importSourceFileSha256: String(n % 10).repeat(64), importMembershipFingerprint: 'c'.repeat(64),
  importExpectedRowCount: 2, importRowCount: 2,
  retirementClassification: null, ...o,
})
// Synthetic A governs to 2026-12-31 and was superseded when B (from 2027-01-01) was activated.
const A = edition(1, { version: '2021', effectiveFrom: '2021-01-01', effectiveTo: '2026-12-31', activationStatus: 'SUPERSEDED', lifecycle: superseded })
const B = edition(2, { version: '2024', effectiveFrom: '2027-01-01', effectiveTo: null })
const chosen = (r: ReturnType<typeof resolveEdition>) => (r.ok && r.value.decisionCode === 'APPLICABLE' ? r.value.edition.edition : r.ok ? r.value.decisionCode : `FAULT ${r.detail}`)

test('the service date alone selects the governing edition, in any activation order (CRG-031–035)', () => {
  assert.equal(chosen(resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [A, B])), '2021')
  assert.equal(chosen(resolveEdition(scope('2027-01-01'), 'ICD-10-CM', [A, B])), '2024')
  assert.equal(chosen(resolveEdition(scope('2026-06-15'), 'ICD-10-CM', [B, A])), '2021')
  // Opposite chronology: B activated first and superseded later by A; each still governs its own dates.
  const A2 = { ...A, activationStatus: 'ACTIVE', lifecycle: activated }
  const B2 = { ...B, activationStatus: 'SUPERSEDED', lifecycle: superseded }
  assert.equal(chosen(resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [B2, A2])), '2021')
  assert.equal(chosen(resolveEdition(scope('2027-01-01'), 'ICD-10-CM', [B2, A2])), '2024')
})

test('no edition, overlap, wrong jurisdiction, competing authority and undated editions fail closed (CRG-039, 040, 046, 047)', () => {
  assert.equal(chosen(resolveEdition(scope('2020-12-31'), 'ICD-10-CM', [A, B])), 'NO_APPROVED_RELEASE')
  assert.equal(chosen(resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [])), 'NO_APPROVED_RELEASE')
  const overlap = edition(3, { version: 'overlap', effectiveFrom: '2026-12-01', effectiveTo: null, datasetId: id(101) })
  assert.equal(chosen(resolveEdition(scope('2026-12-15'), 'ICD-10-CM', [A, overlap])), 'CONFLICTING_RELEASES')
  assert.equal(chosen(resolveEdition(scope('2026-12-31', 'AE-AZ'), 'ICD-10-CM', [A, B])), 'NO_APPROVED_RELEASE')
  assert.equal(chosen(resolveEdition(scope('2026-12-31', 'AE-DU', 'OTHER'), 'ICD-10-CM', [A, B])), 'NO_APPROVED_RELEASE')
  assert.equal(chosen(resolveEdition(scope('2026-12-31'), 'CPT', [A, B])), 'NO_APPROVED_RELEASE')
  assert.equal(chosen(resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [{ ...A, effectiveFrom: null }])), 'NO_APPROVED_RELEASE')
  assert.equal(chosen(resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [{ ...A, mappingPurpose: 'CLAIM_CODING', datasetAuthorityCode: 'SYN-OTHER', mappingAuthorityCode: 'SYN-OTHER' }])), 'NO_APPROVED_RELEASE')
  assert.equal(resolveEdition(scope('31/12/2026'), 'ICD-10-CM', [A]).ok, false)
})

test('unvalidated, never-activated, rejected, unimported and rights-blocked editions are never selected (CRG-021, 026, 027)', () => {
  const draft = edition(4, { validationStatus: 'UNVALIDATED', activationStatus: 'INACTIVE', lifecycle: [] })
  const validatedOnly = edition(5, { activationStatus: 'INACTIVE', lifecycle: [activated[0]] })
  const rejected = edition(6, { validationStatus: 'REJECTED', activationStatus: 'INACTIVE', lifecycle: [{ ...activated[0], nextValidationStatus: 'REJECTED' }] })
  const unimported = edition(7, { importId: null, importSourceFileSha256: null, importMembershipFingerprint: null, importExpectedRowCount: null, importRowCount: 0 })
  for (const blocked of [draft, validatedOnly, rejected, unimported]) assert.equal(chosen(resolveEdition(scope('2026-06-15'), 'ICD-10-CM', [blocked])), 'RELEASE_NOT_AUTHORIZED')
  for (const rights of [{}, { 'ICD-10-CM': 'BLOCKED' as const }]) assert.equal(chosen(resolveEdition(scope('2026-06-15', 'AE-DU', 'SYN', rights), 'ICD-10-CM', [A])), 'RELEASE_NOT_AUTHORIZED')
  // Rights of another system never authorise this one.
  assert.equal(chosen(resolveEdition(scope('2026-06-15', 'AE-DU', 'SYN', { CPT: 'APPROVED' }), 'ICD-10-CM', [A])), 'RELEASE_NOT_AUTHORIZED')
})

test('retirement: prospective keeps historical authority, invalidating or unclassified refuses (CRG-037, 038)', () => {
  const prospective = { ...A, activationStatus: 'RETIRED', lifecycle: retired, retirementClassification: 'PROSPECTIVE' }
  const invalidated = { ...prospective, retirementClassification: 'HISTORICALLY_INVALIDATED' }
  const unclassified = { ...prospective, retirementClassification: null }
  assert.equal(chosen(resolveEdition(scope('2026-06-15'), 'ICD-10-CM', [prospective, B])), '2021')
  assert.equal(chosen(resolveEdition(scope('2026-06-15'), 'ICD-10-CM', [invalidated, B])), 'RELEASE_NOT_AUTHORIZED')
  assert.equal(chosen(resolveEdition(scope('2026-06-15'), 'ICD-10-CM', [unclassified, B])), 'RELEASE_NOT_AUTHORIZED')
  // A retired edition never affects a date it does not cover.
  assert.equal(chosen(resolveEdition(scope('2027-03-01'), 'ICD-10-CM', [invalidated, B])), '2024')
})

test('a stored history that contradicts itself is refused, never guessed (CRG-036)', () => {
  for (const broken of [
    { ...B, lifecycle: [] }, { ...A, lifecycle: activated }, { ...B, validationStatus: 'UNVALIDATED' }, { ...B, mappingCodeSystem: 'ICD-9' }, { ...B, mappingPurpose: 'BILLING' },
    { ...B, mappingAuthorityCode: 'OTHER' }, { ...B, effectiveTo: '2026-01-01' }, { ...B, effectiveFrom: '2027/01/01' }, { ...B, retirementClassification: 'PROSPECTIVE' },
    { ...B, importSourceFileSha256: 'f'.repeat(64) }, { ...B, importRowCount: 1 }, { ...B, importMembershipFingerprint: null }, { ...B, importMembershipFingerprint: 'C'.repeat(64) },
  ]) {
    assert.equal(resolveEdition(scope('2027-01-01'), 'ICD-10-CM', [broken]).ok, false, JSON.stringify(broken).slice(0, 120))
  }
})

test('code identities come from the A2 master and the mapping, never guessed (CRG-013, 014, 045)', () => {
  assert.equal(canonicalCode(' e11.9 '), 'E11.9')
  for (const bad of ['', ' ', 'E11 9', "E11'--", '.E11', null, 7]) assert.equal(canonicalCode(bad), null)
  assert.deepEqual(diagnosisIdentity('e11.9', ['ICD-10-CM', 'CPT']), { ok: true, codeSystem: 'ICD-10-CM', code: 'E11.9' })
  assert.deepEqual(diagnosisIdentity('E11.9', ['CPT']), { ok: false, reason: 'no diagnosis code system is mapped for this jurisdiction', decisionCode: 'NO_APPROVED_RELEASE' })
  assert.equal((diagnosisIdentity('E11 9', ['ICD-10-CM']) as { decisionCode?: string }).decisionCode, 'AMBIGUOUS_CODE_SYSTEM')
  assert.deepEqual(procedureIdentity('CPT', ' 99213 '), { ok: true, codeSystem: 'CPT', code: '99213' })
  assert.deepEqual(procedureIdentity('HCPCS-LEVEL-II', 'j3490'), { ok: true, codeSystem: 'HCPCS-LEVEL-II', code: 'J3490' })
  for (const [system, code] of [[null, '99213'], ['cpt', '99213'], ['SYNTHETIC', '99213'], ['ICD-10-CM', 'E11.9'], ['CPT', null], ['CPT', '']] as const)
    assert.equal((procedureIdentity(system, code) as { decisionCode?: string }).decisionCode, 'AMBIGUOUS_CODE_SYSTEM')
})

test('membership is judged in exactly the governing edition, against its release checksum (CRG-015, 041–044)', () => {
  const m = (n: number, release: string): MembershipBasis => ({ membershipId: id(200 + n), sourceRowId: `row-${n}`, sourceRowSha256: String(n).repeat(64), releaseContentHash: release })
  const rows: Record<string, MembershipBasis> = {
    [`${A.datasetVersionId}|ICD-10-CM|E11.9`]: m(1, A.contentHash), [`${B.datasetVersionId}|ICD-10-CM|E11.9`]: m(2, B.contentHash),
    [`${A.datasetVersionId}|ICD-10-CM|R69`]: m(3, A.contentHash), [`${B.datasetVersionId}|ICD-10-CM|U09.9`]: m(4, B.contentHash),
  }
  const lookup = (v: string, s: string, c: string) => rows[`${v}|${s}|${c}`] ?? null
  const decide = (date: string, code: string) => decideCode(scope(date), diagnosisIdentity(code, ['ICD-10-CM']), [A, B], lookup)
  const code = (r: ReturnType<typeof decide>) => (r.ok ? r.value.decisionCode : 'FAULT')
  const inA = decide('2026-12-31', 'E11.9')
  const inB = decide('2027-01-01', 'E11.9')
  assert.ok(inA.ok && inB.ok)
  assert.equal(inA.value.edition?.referenceDatasetVersionId, A.datasetVersionId)
  assert.notEqual(inA.value.membership?.sourceRowSha256, inB.value.membership?.sourceRowSha256)
  assert.equal(inA.value.membership?.releaseContentHash, A.contentHash)
  assert.equal(code(decide('2026-12-31', 'R69')), 'APPLICABLE')
  assert.equal(code(decide('2027-01-01', 'R69')), 'CODE_NOT_IN_RELEASE')
  assert.equal(code(decide('2027-01-01', 'U09.9')), 'APPLICABLE')
  assert.equal(code(decide('2026-12-31', 'U09.9')), 'CODE_NOT_IN_RELEASE')
  assert.equal(code(decide('2026-12-31', 'Z99.9')), 'CODE_NOT_IN_RELEASE')
  assert.deepEqual(decideCode(scope('2027-01-01'), procedureIdentity(null, '99213'), [A, B], lookup), { ok: true, value: { decisionCode: 'AMBIGUOUS_CODE_SYSTEM', codeSystem: null, edition: null, membership: null } })
  // A membership whose release checksum differs from its edition is a refusal of the whole decision.
  assert.equal(decideCode(scope('2026-12-31'), diagnosisIdentity('E11.9', ['ICD-10-CM']), [A, B], () => m(9, 'e'.repeat(64))).ok, false)
})

test('source artifact and membership fingerprints are separate and each reproducible; the resolver is deterministic (CRG-022, 050, F02)', () => {
  const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  const text = 'r2\tb1\nr1\tA1\n'
  const bytes = Buffer.from(text, 'utf8')
  const parsed = parseReleaseArtifact('CRG-SYNTHETIC-TSV-1', bytes)
  assert.ok(parsed.ok)
  // The artifact's own SHA-256 over its exact bytes; each record's over its own line; codes normalized.
  assert.equal(parsed.value.sourceFileSha256, sha(bytes))
  assert.equal(parsed.value.byteLength, bytes.length)
  assert.deepEqual(parsed.value.rows, [{ sourceRowId: 'r2', code: 'B1', sourceRowSha256: sha('r2\tb1') }, { sourceRowId: 'r1', code: 'A1', sourceRowSha256: sha('r1\tA1') }])
  const rows = parsed.value.rows
  // The membership fingerprint is a different value, order-independent and bound to every row.
  assert.notEqual(membershipFingerprint(rows), parsed.value.sourceFileSha256)
  assert.equal(membershipFingerprint(rows), membershipFingerprint([...rows].reverse()))
  assert.equal(membershipFingerprint(rows), sha(`r1\tA1\t${sha('r1\tA1')}\nr2\tB1\t${sha('r2\tb1')}\n`))
  assert.notEqual(membershipFingerprint(rows), membershipFingerprint([rows[0]]))
  assert.notEqual(membershipFingerprint(rows), membershipFingerprint([{ ...rows[0], code: 'B2' }, rows[1]]))
  // One changed byte changes the artifact's hash; the reader refuses anything it cannot read exactly.
  assert.notEqual((parseReleaseArtifact('CRG-SYNTHETIC-TSV-1', Buffer.from('r2\tB1\nr1\tA1\n')) as { value: { sourceFileSha256: string } }).value.sourceFileSha256, parsed.value.sourceFileSha256)
  for (const bad of ['', 'r1\tA1', 'r1\tA1\r\n', 'r1\tA1\tlicensed descriptor\n', 'r1\tA1\nr1\tB1\n', 'r1\tA1\nr2\tA1\n', 'r1\tA 1\n', ' r1\tA1\n', 'r1\tA1\n\n'])
    assert.equal(parseReleaseArtifact('CRG-SYNTHETIC-TSV-1', Buffer.from(bad, 'utf8')).ok, false, JSON.stringify(bad))
  assert.equal(parseReleaseArtifact('CRG-SYNTHETIC-TSV-1', Buffer.from([0x72, 0x31, 0x09, 0xff, 0x0a])).ok, false)
  assert.equal(parseReleaseArtifact('ICD10CM-ORDER-2024' as 'CRG-SYNTHETIC-TSV-1', bytes).ok, false)
  const first = JSON.stringify([resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [A, B]), resolveEdition(scope('2027-01-01'), 'ICD-10-CM', [B, A])])
  for (let i = 0; i < 100; i += 1) assert.equal(JSON.stringify([resolveEdition(scope('2026-12-31'), 'ICD-10-CM', [A, B]), resolveEdition(scope('2027-01-01'), 'ICD-10-CM', [B, A])]), first)
})
