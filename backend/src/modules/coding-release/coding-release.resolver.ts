import {
  CANONICAL_CODE,
  CODE_SYSTEM_SUBJECT,
  SHA256_HEX,
  codeSystems,
  mappingPurposes,
  retirementClassifications,
  type CodeDecision,
  type CodeIdentity,
  type CodeSystem,
  type EditionFacts,
  type EditionResult,
  type MappingPurpose,
  type MembershipBasis,
  type ResolutionScope,
  type RetirementClassification,
} from './coding-release.types.ts'

// CRG-01 FINAL §4.2 — the one pure, deterministic coding-release resolver. It reads the encounter's service date and
// jurisdiction, the rights recorded there, the A3 editions mapped to one code system with their immutable lifecycle
// histories, CRG imports and retirement classifications, and the membership of one canonical code; it answers a
// decision with its basis. It never reads a clock, locale, database or network, never chooses the newest edition or
// one by id, and never repairs a history.
//
//   1. Scope: editions whose CRG mapping names exactly this code system for CLAIM_CODING and whose dataset's
//      jurisdiction and authority equal the encounter's facility profile (compared trimmed and upper-cased, as A3
//      compares them).
//   2. Cover: effectiveFrom present and on or before the service date, effectiveTo absent or on or after it (inclusive
//      calendar dates). An edition without an effectiveFrom cannot prove it governs the date and is never selected.
//   3. Rights: when the code system's rights here are not APPROVED, a covering edition is never used
//      (RELEASE_NOT_AUTHORIZED).
//   4. Retirement: a RETIRED covering edition is used only when classified PROSPECTIVE (its historical authority is
//      kept); HISTORICALLY_INVALIDATED or unclassified refuses the decision (RELEASE_NOT_AUTHORIZED).
//   5. Approved: VALIDATED, activated at least once by its lifecycle history, ACTIVE or SUPERSEDED or PROSPECTIVE
//      RETIRED now, and imported completely through CRG (its import's source artifact SHA-256 equals the edition's
//      content hash, it carries its own membership fingerprint, and its row count equals the declared count).
//   6. None approved: NO_APPROVED_RELEASE when nothing covers the date, RELEASE_NOT_AUTHORIZED when something covers it
//      but is not approved. More than one approved: CONFLICTING_RELEASES. Exactly one: that edition.
//   7. The code must be a member of exactly that edition: APPLICABLE, otherwise CODE_NOT_IN_RELEASE.

const norm = (value: string) => value.trim().toUpperCase()
const isCodeSystem = (value: unknown): value is CodeSystem => typeof value === 'string' && (codeSystems as readonly string[]).includes(value)
const isPurpose = (value: unknown): value is MappingPurpose => typeof value === 'string' && (mappingPurposes as readonly string[]).includes(value)
const isClassification = (value: unknown): value is RetirementClassification => typeof value === 'string' && (retirementClassifications as readonly string[]).includes(value)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const ACTIVATING = new Set(['ACTIVATE', 'ROLLBACK'])
const PURPOSE: MappingPurpose = 'CLAIM_CODING'

// The stored facts of one edition must agree with themselves before any of them is used.
function inconsistency(edition: EditionFacts): string | null {
  if (!isCodeSystem(edition.mappingCodeSystem) || !isPurpose(edition.mappingPurpose)) return 'a dataset is mapped to an uncontrolled code system or purpose'
  if (norm(edition.mappingJurisdictionCode) !== norm(edition.datasetJurisdictionCode) || norm(edition.mappingAuthorityCode) !== norm(edition.datasetAuthorityCode))
    return "a code-system mapping no longer matches its dataset's jurisdiction or authority"
  if ((edition.effectiveFrom !== null && !DATE.test(edition.effectiveFrom)) || (edition.effectiveTo !== null && !DATE.test(edition.effectiveTo)))
    return 'an edition carries a malformed effective date'
  if (edition.effectiveFrom !== null && edition.effectiveTo !== null && edition.effectiveFrom > edition.effectiveTo) return 'an edition ends before it starts'
  const last = edition.lifecycle[edition.lifecycle.length - 1]
  if (last ? last.nextActivationStatus !== edition.activationStatus : edition.activationStatus !== 'INACTIVE')
    return "an edition's current state does not follow from its lifecycle history"
  if (edition.activationStatus === 'ACTIVE' && edition.validationStatus !== 'VALIDATED') return 'an ACTIVE edition is not VALIDATED'
  if (edition.retirementClassification !== null && (!isClassification(edition.retirementClassification) || edition.activationStatus !== 'RETIRED'))
    return 'a retirement classification names an edition that is not RETIRED'
  if (
    edition.importId !== null &&
    (edition.importSourceFileSha256 !== edition.contentHash ||
      edition.importExpectedRowCount !== edition.importRowCount ||
      edition.importMembershipFingerprint === null ||
      !SHA256_HEX.test(edition.importMembershipFingerprint))
  )
    return "an edition's CRG import does not match its content hash, its declared row count or its membership fingerprint"
  return null
}

const covers = (edition: EditionFacts, date: string) => edition.effectiveFrom !== null && edition.effectiveFrom <= date && (edition.effectiveTo === null || edition.effectiveTo >= date)

const retirementBlocks = (edition: EditionFacts) => edition.activationStatus === 'RETIRED' && edition.retirementClassification !== 'PROSPECTIVE'

const approved = (edition: EditionFacts) =>
  edition.validationStatus === 'VALIDATED' &&
  (edition.activationStatus === 'ACTIVE' || edition.activationStatus === 'SUPERSEDED' || (edition.activationStatus === 'RETIRED' && edition.retirementClassification === 'PROSPECTIVE')) &&
  edition.lifecycle.some((event) => ACTIVATING.has(event.action)) &&
  edition.importId !== null

export function resolveEdition(scope: ResolutionScope, codeSystem: CodeSystem, editions: readonly EditionFacts[]): EditionResult {
  if (!DATE.test(scope.serviceDate)) return { ok: false, detail: 'the service date is not a calendar date' }
  for (const edition of editions) {
    const fault = inconsistency(edition)
    if (fault) return { ok: false, detail: fault }
  }
  const inScope = editions.filter(
    (edition) =>
      edition.mappingCodeSystem === codeSystem && edition.mappingPurpose === PURPOSE && norm(edition.datasetJurisdictionCode) === norm(scope.jurisdictionCode) && norm(edition.datasetAuthorityCode) === norm(scope.authorityCode),
  )
  const covering = inScope.filter((edition) => covers(edition, scope.serviceDate))
  if (covering.length > 0 && scope.rights[codeSystem] !== 'APPROVED') return { ok: true, value: { decisionCode: 'RELEASE_NOT_AUTHORIZED', edition: null } }
  if (covering.some(retirementBlocks)) return { ok: true, value: { decisionCode: 'RELEASE_NOT_AUTHORIZED', edition: null } }
  const candidates = covering.filter(approved)
  if (candidates.length === 0) return { ok: true, value: { decisionCode: covering.length === 0 ? 'NO_APPROVED_RELEASE' : 'RELEASE_NOT_AUTHORIZED', edition: null } }
  if (candidates.length > 1) return { ok: true, value: { decisionCode: 'CONFLICTING_RELEASES', edition: null } }
  const [chosen] = candidates
  return {
    ok: true,
    value: {
      decisionCode: 'APPLICABLE',
      edition: {
        referenceDatasetVersionId: chosen.datasetVersionId,
        datasetId: chosen.datasetId,
        codeSystem,
        purpose: PURPOSE,
        edition: chosen.version,
        effectiveFrom: chosen.effectiveFrom as string,
        effectiveTo: chosen.effectiveTo,
        sourceVersionId: chosen.sourceVersionId,
        contentHash: chosen.contentHash,
        membershipFingerprintSha256: chosen.importMembershipFingerprint as string,
        importId: chosen.importId as string,
        activationStatus: chosen.activationStatus,
        retirementClassification: chosen.retirementClassification as RetirementClassification | null,
      },
    },
  }
}

// The canonical form of a code value, or null when the value is not one.
export function canonicalCode(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toUpperCase()
  return CANONICAL_CODE.test(code) ? code : null
}

// A diagnosis states no code system in its A2 master. Its system is the one diagnosis system mapped for this
// jurisdiction (never inferred from DHA). None mapped means no release governs it here (NO_APPROVED_RELEASE); more
// than one is never guessed (AMBIGUOUS_CODE_SYSTEM).
export function diagnosisIdentity(code: string, mappedSystems: readonly string[]): CodeIdentity {
  const value = canonicalCode(code)
  if (!value) return { ok: false, reason: 'the diagnosis code is not a canonical code value', decisionCode: 'AMBIGUOUS_CODE_SYSTEM' }
  const systems = [...new Set(mappedSystems.filter((system) => isCodeSystem(system) && CODE_SYSTEM_SUBJECT[system] === 'DIAGNOSIS'))] as CodeSystem[]
  if (systems.length === 0) return { ok: false, reason: 'no diagnosis code system is mapped for this jurisdiction', decisionCode: 'NO_APPROVED_RELEASE' }
  if (systems.length > 1) return { ok: false, reason: 'more than one diagnosis code system is mapped for this jurisdiction', decisionCode: 'AMBIGUOUS_CODE_SYSTEM' }
  return { ok: true, codeSystem: systems[0], code: value }
}

// A procedure states its system and external code in its A2 master; both must be present and the system must be
// exactly a controlled procedure system (no normalisation of the system name). The internal code is never used as a
// licensed external code.
export function procedureIdentity(codeSystem: string | null, externalCode: string | null): CodeIdentity {
  if (!isCodeSystem(codeSystem) || CODE_SYSTEM_SUBJECT[codeSystem] !== 'PROCEDURE')
    return { ok: false, reason: 'the procedure code states no controlled procedure code system', decisionCode: 'AMBIGUOUS_CODE_SYSTEM' }
  const value = canonicalCode(externalCode)
  if (!value) return { ok: false, reason: 'the procedure code states no canonical external code', decisionCode: 'AMBIGUOUS_CODE_SYSTEM' }
  return { ok: true, codeSystem, code: value }
}

// The whole decision for one code: identity first (a refused identity carries its own decision), then the edition,
// then membership in exactly that edition. `membershipOf` answers the stored membership of a code in one edition.
export function decideCode(
  scope: ResolutionScope,
  identity: CodeIdentity,
  editions: readonly EditionFacts[],
  membershipOf: (datasetVersionId: string, codeSystem: CodeSystem, code: string) => MembershipBasis | null,
): { ok: true; value: CodeDecision } | { ok: false; detail: string } {
  if (!identity.ok) return { ok: true, value: { decisionCode: identity.decisionCode, codeSystem: null, edition: null, membership: null } }
  const edition = resolveEdition(scope, identity.codeSystem, editions)
  if (!edition.ok) return edition
  if (edition.value.decisionCode !== 'APPLICABLE') return { ok: true, value: { decisionCode: edition.value.decisionCode, codeSystem: identity.codeSystem, edition: null, membership: null } }
  const membership = membershipOf(edition.value.edition.referenceDatasetVersionId, identity.codeSystem, identity.code)
  if (membership && membership.releaseContentHash !== edition.value.edition.contentHash) return { ok: false, detail: "a membership row's release checksum differs from its edition's content hash" }
  return {
    ok: true,
    value: membership
      ? { decisionCode: 'APPLICABLE', codeSystem: identity.codeSystem, edition: edition.value.edition, membership }
      : { decisionCode: 'CODE_NOT_IN_RELEASE', codeSystem: identity.codeSystem, edition: edition.value.edition, membership: null },
  }
}
