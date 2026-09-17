import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import {
  activateRuleSourceVersion,
  evaluateRuleSourceVersionActivation,
  retireRuleSourceVersion,
  suspendRuleSourceVersion,
} from '../modules/rule-source-version/rule-source-version.service.ts'
import { evaluateExecutability } from '../modules/rule-source-binding/rule-source-binding.service.ts'
import { executabilityBlockerCodes } from '../modules/rule-source-binding/rule-source-binding.validation.ts'
import { APPLICABILITY_DIMENSIONS_V2, type ApplicabilityDimensionKeyV2 } from '../shared/rules/applicability-context-v2.ts'

// Audit C35 — the auditor's confirmed decision: DEPENDS_ON is a LIFECYCLE dependency. The target
// must be ACTIVE for the dependency to be resolved; its effective dates are its own concern and do
// not enter this check, and a DEPENDS_ON edge never becomes a precedence or governing relation.
// A3.4's code already conforms, so this package adds the missing proof only — no behaviour change.

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label} ${detail}`)
  }
}

function section(title: string) {
  console.log(`\n[a3-dependency] ${title}`)
}

function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

const tag = `A3DEP-${Date.now()}`
const organizationId = process.env.AUTHZ_BOOTSTRAP_ORGANIZATION_ID
const userEmail = process.env.AUTHZ_BOOTSTRAP_USER_EMAIL
const publicVocabulary = new Set<string>(executabilityBlockerCodes)

function emptyContext(): Record<ApplicabilityDimensionKeyV2, unknown> {
  const context = {} as Record<ApplicabilityDimensionKeyV2, unknown>
  for (const key of APPLICABILITY_DIMENSIONS_V2) context[key] = null
  return context
}

async function main() {
  if (!organizationId || !userEmail) throw new Error('AUTHZ_BOOTSTRAP_ORGANIZATION_ID and AUTHZ_BOOTSTRAP_USER_EMAIL are required')
  const org = organizationId
  const actor = (await prisma.user.findUniqueOrThrow({ where: { email: userEmail } })).id
  console.log(`[a3-dependency] run tag ${tag} — organization ${org}`)

  let counter = 0

  // A source version that is fully activatable on its own: PUBLISHED, VERIFIED, dated, with a
  // VERIFIED interpretation. Every blocker except DEPENDENCY_UNRESOLVED is therefore absent, so
  // the dependency check is the only thing this script can be measuring.
  async function version(name: string, effectiveFrom = '2020-01-01', effectiveTo: string | null = '2030-12-31') {
    counter += 1
    const source = await prisma.ruleSource.create({
      data: {
        organizationId: org,
        jurisdictionCode: 'AE-DU',
        issuingAuthority: 'Synthetic Authority',
        sourceCategory: 'REGULATORY_AUTHORITY',
        referenceNumber: `${tag}-${counter}-${name}`,
        title: `Dependency ${name}`,
        ownershipScope: 'ORGANIZATION',
      },
    })
    const record = await prisma.ruleSourceVersion.create({
      data: {
        sourceId: source.id,
        version: '1',
        rawEvidenceRef: `synthetic-evidence://${tag}/${counter}-${name}`,
        publicationStatus: 'PUBLISHED',
        publicationDate: d('2020-01-01'),
        effectiveFrom: d(effectiveFrom),
        effectiveTo: effectiveTo ? d(effectiveTo) : null,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    await prisma.sourceInterpretation.create({
      data: {
        sourceVersionId: record.id,
        interpretationVersion: '1',
        normalizedInterpretationRef: `synthetic-interpretation://${tag}/${counter}-${name}`,
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    return record
  }

  async function dependsOn(fromId: string, toId: string) {
    await prisma.ruleSourceRelationship.create({
      data: { fromSourceVersionId: fromId, toSourceVersionId: toId, relationshipType: 'DEPENDS_ON' },
    })
  }

  // The dependency check is read-only here: evaluate (not activate) reports the blockers without
  // changing any state, so one dependent can be measured against many target states.
  async function blockers(versionId: string): Promise<string[]> {
    const result = await evaluateRuleSourceVersionActivation(versionId, '2026-06-15', 'AE-DU')
    if (!result.ok) throw new Error(`evaluate returned ${result.code}: ${result.message}`)
    return result.value.blockers
  }

  async function resolvesFor(label: string, versionId: string) {
    const list = await blockers(versionId)
    check(`${label}: dependency resolved`, !list.includes('DEPENDENCY_UNRESOLVED'), list.join(',') || '(no blockers)')
    check(`${label}: no other blocker appeared either`, list.length === 0, list.join(','))
  }

  async function unresolvedFor(label: string, versionId: string) {
    const list = await blockers(versionId)
    check(`${label}: DEPENDENCY_UNRESOLVED reported`, list.includes('DEPENDENCY_UNRESOLVED'), list.join(',') || '(no blockers)')
  }

  section('C35 an ACTIVE dependency resolves')
  {
    const target = await version('active-target')
    const dependent = await version('active-dependent')
    await dependsOn(dependent.id, target.id)
    await unresolvedFor('before the target is activated', dependent.id)
    const activated = await activateRuleSourceVersion(target.id, '2026-06-15', 'AE-DU', actor)
    check('fixture: the target activates', activated.ok && activated.value.activationStatus === 'ACTIVE', JSON.stringify(activated))
    await resolvesFor('an ACTIVE target', dependent.id)

    const dependentActivated = await activateRuleSourceVersion(dependent.id, '2026-06-15', 'AE-DU', actor)
    check('the dependent can now activate', dependentActivated.ok && dependentActivated.value.activationStatus === 'ACTIVE', JSON.stringify(dependentActivated))
    const targetAfter = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: target.id } })
    check(
      'activating the dependent leaves the target untouched — DEPENDS_ON has no lifecycle side effect',
      targetAfter.activationStatus === 'ACTIVE' && targetAfter.supersededAt === null && targetAfter.retiredAt === null,
      JSON.stringify({ status: targetAfter.activationStatus, supersededAt: targetAfter.supersededAt, retiredAt: targetAfter.retiredAt }),
    )
  }

  section('C35 an ACTIVE dependency whose own effective window has expired still resolves')
  {
    // The confirmed decision: DEPENDS_ON is a lifecycle dependency, so the target's dates are the
    // target's own concern. A date-expired but still-ACTIVE target is a resolved dependency.
    const target = await version('expired-target', '2020-01-01', '2026-01-31')
    const dependent = await version('expired-dependent')
    await dependsOn(dependent.id, target.id)
    const activated = await activateRuleSourceVersion(target.id, '2025-06-15', 'AE-DU', actor)
    check('fixture: the target activates on a date inside its own window', activated.ok, JSON.stringify(activated))
    const stored = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: target.id } })
    check(
      'fixture: the target is ACTIVE and its effective window ended before the business date',
      stored.activationStatus === 'ACTIVE' && stored.effectiveTo !== null && stored.effectiveTo < d('2026-06-15'),
      JSON.stringify({ status: stored.activationStatus, effectiveTo: stored.effectiveTo }),
    )
    await resolvesFor('an ACTIVE but date-expired target', dependent.id)
    // Guard against the opposite mistake: it must resolve because the target is ACTIVE, not
    // because the dependency check is a no-op.
    const targetBlockers = await blockers(target.id)
    check(
      'the target itself is the one that reports its own date problem, not the dependent',
      targetBlockers.includes('SOURCE_NOT_EFFECTIVE') || targetBlockers.includes('EFFECTIVE_DATE_INCOMPLETE'),
      targetBlockers.join(',') || '(no blockers)',
    )
  }

  section('C35 every non-ACTIVE dependency status leaves the dependency unresolved')
  {
    const dependent = await version('status-dependent')

    const inactive = await version('status-inactive')
    await dependsOn(dependent.id, inactive.id)
    await unresolvedFor('INACTIVE target', dependent.id)
    await prisma.ruleSourceRelationship.deleteMany({ where: { fromSourceVersionId: dependent.id } })

    // BLOCKED is reached the real way: a failed activation caused by its own unresolved dependency.
    const blocked = await version('status-blocked')
    const blockedDependency = await version('status-blocked-dep')
    await dependsOn(blocked.id, blockedDependency.id)
    const failedActivation = await activateRuleSourceVersion(blocked.id, '2026-06-15', 'AE-DU', actor)
    const blockedStored = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: blocked.id } })
    check('fixture: a failed activation lands on BLOCKED', failedActivation.ok && blockedStored.activationStatus === 'BLOCKED', JSON.stringify(failedActivation))
    await dependsOn(dependent.id, blocked.id)
    await unresolvedFor('BLOCKED target', dependent.id)
    await prisma.ruleSourceRelationship.deleteMany({ where: { fromSourceVersionId: dependent.id } })

    const suspended = await version('status-suspended')
    await activateRuleSourceVersion(suspended.id, '2026-06-15', 'AE-DU', actor)
    const suspendResult = await suspendRuleSourceVersion(suspended.id, actor)
    check('fixture: the target suspends', suspendResult.ok && suspendResult.value.activationStatus === 'SUSPENDED', JSON.stringify(suspendResult))
    await dependsOn(dependent.id, suspended.id)
    await unresolvedFor('SUSPENDED target', dependent.id)
    await prisma.ruleSourceRelationship.deleteMany({ where: { fromSourceVersionId: dependent.id } })

    // SUPERSEDED is reached the real way too: a successor with a SUPERSEDES edge activates.
    const superseded = await version('status-superseded')
    await activateRuleSourceVersion(superseded.id, '2026-06-15', 'AE-DU', actor)
    const successor = await version('status-successor')
    await prisma.ruleSourceRelationship.create({
      data: { fromSourceVersionId: successor.id, toSourceVersionId: superseded.id, relationshipType: 'SUPERSEDES' },
    })
    const successorActivated = await activateRuleSourceVersion(successor.id, '2026-06-15', 'AE-DU', actor)
    const supersededStored = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: superseded.id } })
    check(
      'fixture: activating the successor supersedes the target',
      successorActivated.ok && supersededStored.activationStatus === 'SUPERSEDED',
      JSON.stringify({ successorActivated: successorActivated.ok, status: supersededStored.activationStatus }),
    )
    await dependsOn(dependent.id, superseded.id)
    await unresolvedFor('SUPERSEDED target', dependent.id)
    check(
      'a historical SUPERSEDED dependency is NOT silently treated as valid',
      (await blockers(dependent.id)).includes('DEPENDENCY_UNRESOLVED'),
    )
    const attemptedActivation = await activateRuleSourceVersion(dependent.id, '2026-06-15', 'AE-DU', actor)
    const dependentStored = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: dependent.id } })
    check(
      'a dependent on a SUPERSEDED target cannot reach ACTIVE',
      attemptedActivation.ok && dependentStored.activationStatus === 'BLOCKED' && dependentStored.activationBlockers.includes('DEPENDENCY_UNRESOLVED'),
      JSON.stringify({ status: dependentStored.activationStatus, blockers: dependentStored.activationBlockers }),
    )
    await prisma.ruleSourceRelationship.deleteMany({ where: { fromSourceVersionId: dependent.id } })

    const retired = await version('status-retired')
    await activateRuleSourceVersion(retired.id, '2026-06-15', 'AE-DU', actor)
    const retireResult = await retireRuleSourceVersion(retired.id, actor)
    check('fixture: the target retires', retireResult.ok && retireResult.value.activationStatus === 'RETIRED', JSON.stringify(retireResult))
    await dependsOn(dependent.id, retired.id)
    await unresolvedFor('RETIRED target', dependent.id)
  }

  section('C35 one unresolved target among several is enough')
  {
    const dependent = await version('many-dependent')
    const okTargetA = await version('many-ok-a')
    const okTargetB = await version('many-ok-b')
    const badTarget = await version('many-bad')
    await activateRuleSourceVersion(okTargetA.id, '2026-06-15', 'AE-DU', actor)
    await activateRuleSourceVersion(okTargetB.id, '2026-06-15', 'AE-DU', actor)
    await dependsOn(dependent.id, okTargetA.id)
    await dependsOn(dependent.id, okTargetB.id)
    await resolvesFor('every target ACTIVE', dependent.id)
    await dependsOn(dependent.id, badTarget.id)
    await unresolvedFor('one INACTIVE target among three', dependent.id)
  }

  section('C35 DEPENDS_ON never becomes a precedence or governing relation')
  {
    // A3.7 governing-candidate evaluation is the gate that feeds A3.8 precedence. A binding names
    // exactly one interpretation; the interpretation of a DEPENDS_ON target must never be pulled
    // in as an extra candidate, and the edge must not change the bound candidate's own verdict.
    const rule = await prisma.ruleDefinition.create({
      data: {
        organizationId: org,
        ruleKey: `${tag}-precedence`,
        displayName: 'Dependency precedence',
        jurisdictionCode: 'AE-DU',
        ownershipScope: 'ORGANIZATION',
      },
    })
    const ruleVersion = await prisma.ruleVersion.create({
      data: {
        ruleId: rule.id,
        version: '1',
        effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT',
        effectiveFrom: d('2020-01-01'),
        verificationStatus: 'VERIFIED',
        verifiedAt: new Date(),
      },
    })
    await prisma.ruleApplicability.create({ data: { ruleVersionId: ruleVersion.id } })

    const bound = await version('precedence-bound')
    const target = await version('precedence-target')
    await activateRuleSourceVersion(target.id, '2026-06-15', 'AE-DU', actor)
    await dependsOn(bound.id, target.id)
    await activateRuleSourceVersion(bound.id, '2026-06-15', 'AE-DU', actor)

    const boundInterpretation = await prisma.sourceInterpretation.findFirstOrThrow({ where: { sourceVersionId: bound.id } })
    const targetInterpretation = await prisma.sourceInterpretation.findFirstOrThrow({ where: { sourceVersionId: target.id } })
    const binding = await prisma.ruleSourceBinding.create({
      data: { ruleVersionId: ruleVersion.id, sourceInterpretationId: boundInterpretation.id, sourceRole: 'GOVERNING' },
    })

    const evaluated = await evaluateExecutability(ruleVersion.id, '2026-06-15', emptyContext())
    if (!evaluated.ok) throw new Error(`evaluate returned ${evaluated.code}: ${evaluated.message}`)
    check('the bound governing candidate passes the A3.7 gate', evaluated.value.gateStatus === 'POTENTIALLY_ALLOWED', JSON.stringify(evaluated.value))
    check(
      'only the bound binding is reported — the DEPENDS_ON edge adds no binding',
      evaluated.value.governingBindingIds.length === 1 && evaluated.value.governingBindingIds[0] === binding.id,
      JSON.stringify(evaluated.value.governingBindingIds),
    )
    check(
      'the dependency target interpretation is never a candidate for precedence',
      evaluated.value.candidateSourceInterpretationIds.length === 1 &&
        evaluated.value.candidateSourceInterpretationIds[0] === boundInterpretation.id &&
        !evaluated.value.candidateSourceInterpretationIds.includes(targetInterpretation.id),
      JSON.stringify(evaluated.value.candidateSourceInterpretationIds),
    )
    check('no supporting binding was invented from the edge', evaluated.value.supportingBindingIds.length === 0, JSON.stringify(evaluated.value.supportingBindingIds))

    // Break the dependency AFTER both are ACTIVE. A3.7 re-evaluates each governing candidate's
    // activatability live (A3-COMPAT-1), so the dependency is reported against the BOUND candidate
    // — DEPENDENCY_UNRESOLVED is a documented member of A3.7's fifteen-code vocabulary. What must
    // still never happen is the target being promoted into candidacy by the edge.
    const suspendTarget = await suspendRuleSourceVersion(target.id, actor)
    check('fixture: the dependency target is suspended after both were ACTIVE', suspendTarget.ok, JSON.stringify(suspendTarget))
    const reEvaluated = await evaluateExecutability(ruleVersion.id, '2026-06-15', emptyContext())
    if (!reEvaluated.ok) throw new Error(`evaluate returned ${reEvaluated.code}: ${reEvaluated.message}`)
    check(
      'the broken dependency blocks the BOUND candidate, so the rule no longer advances',
      reEvaluated.value.gateStatus === 'BLOCKED' && reEvaluated.value.nextGate === null,
      JSON.stringify(reEvaluated.value),
    )
    check(
      'it is reported with the documented executability codes, not a raw lifecycle leak',
      reEvaluated.value.blockers.includes('DEPENDENCY_UNRESOLVED') &&
        reEvaluated.value.blockers.includes('MISSING_GOVERNING_SOURCE') &&
        reEvaluated.value.blockers.every((code) => publicVocabulary.has(code)),
      reEvaluated.value.blockers.join(','),
    )
    check(
      'the dependency target is STILL not a candidate — a broken edge does not promote it either',
      reEvaluated.value.candidateSourceInterpretationIds.length === 0 &&
        reEvaluated.value.governingBindingIds.length === 1 &&
        reEvaluated.value.governingBindingIds[0] === binding.id &&
        reEvaluated.value.supportingBindingIds.length === 0,
      JSON.stringify(reEvaluated.value),
    )
    check(
      'the dependent version reports the same unresolved dependency at the A3.3 layer',
      (await blockers(bound.id)).includes('DEPENDENCY_UNRESOLVED'),
    )
    const targetStored = await prisma.ruleSourceVersion.findUniqueOrThrow({ where: { id: target.id } })
    check(
      'the edge stayed a DEPENDS_ON lifecycle edge throughout — the target was never superseded by it',
      targetStored.activationStatus === 'SUSPENDED' && targetStored.supersededAt === null,
      JSON.stringify({ status: targetStored.activationStatus, supersededAt: targetStored.supersededAt }),
    )
  }

  console.log(`\n[a3-dependency] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3-dependency] ALL CHECKS PASS' : '[a3-dependency] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3-dependency] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
