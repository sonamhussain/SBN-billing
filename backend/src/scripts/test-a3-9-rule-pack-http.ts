import 'dotenv/config'
import { prisma } from '../shared/database/prisma.ts'
import { callApi, extractCookieHeader } from '../integration/a1-foundation/integration.http.ts'

// A3.9 — rule pack API, end to end over HTTP against the running server (T05–T35). Reuses the
// shared A1 integration HTTP helper; nothing from a prior suite is copied. Synthetic fixtures only.

const baseUrl = process.env.A1_IT_BASE_URL as string
const adminEmail = process.env.A1_IT_ADMIN_EMAIL as string
const adminPassword = process.env.A1_IT_ADMIN_PASSWORD as string
const viewerEmail = process.env.A1_IT_VIEWER_EMAIL as string
const viewerPassword = process.env.A1_IT_VIEWER_PASSWORD as string
const org = process.env.A1_IT_ORGANIZATION_ID as string
const otherOrg = process.env.A1_IT_OTHER_ORGANIZATION_ID as string

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
  console.log(`\n[a3.9-http] ${title}`)
}

const tag = `A39H-${Date.now()}`
function d(text: string): Date {
  return new Date(`${text}T00:00:00.000Z`)
}

async function signIn(email: string, password: string) {
  const res = await callApi(baseUrl, '/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email, password }),
  })
  return { status: res.status, cookie: extractCookieHeader(res.setCookies) }
}

async function main() {
  for (const [key, value] of Object.entries({ baseUrl, adminEmail, adminPassword, viewerEmail, viewerPassword, org, otherOrg }))
    if (!value) throw new Error(`missing integration env for ${key}`)
  console.log(`[a3.9-http] running against ${baseUrl} (tag ${tag})`)

  const admin = await signIn(adminEmail, adminPassword)
  const viewer = await signIn(viewerEmail, viewerPassword)
  check('admin and viewer sign in', admin.status === 200 && viewer.status === 200 && !!admin.cookie && !!viewer.cookie)

  const api = (cookie: string) => ({
    get: (path: string) => callApi(baseUrl, path, { headers: { Cookie: cookie } }),
    del: (path: string) => callApi(baseUrl, path, { method: 'DELETE', headers: { Cookie: cookie, Origin: baseUrl } }),
    send: (method: 'POST' | 'PATCH', path: string, body: unknown) =>
      callApi(baseUrl, path, {
        method,
        headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: baseUrl },
        body: JSON.stringify(body),
      }),
  })
  const A = api(admin.cookie)
  const V = api(viewer.cookie)
  const auditCount = () => prisma.auditEvent.count({ where: { organizationId: org } })

  // ---- synthetic rule fixtures (direct rows; RuleVersion lifecycle is A3.5's, not under test) --
  let n = 0
  async function ruleVersion(owner: string | null, jurisdictionCode: string, verified: boolean) {
    n += 1
    const rule = await prisma.ruleDefinition.create({
      data: {
        organizationId: owner,
        ownershipScope: owner ? 'ORGANIZATION' : 'SYSTEM_SHARED',
        ruleKey: `${tag}-rule-${n}`,
        displayName: `A3.9 rule ${n}`,
        jurisdictionCode,
      },
    })
    return prisma.ruleVersion.create({
      data: {
        ruleId: rule.id,
        version: '1',
        effectType: 'AUTHORIZATION_REQUIREMENT_EFFECT',
        effectiveFrom: d('2020-01-01'),
        verificationStatus: verified ? 'VERIFIED' : 'UNVERIFIED',
        verifiedAt: verified ? new Date() : null,
      },
    })
  }
  const ownVerified = await ruleVersion(org, 'AE-DU', true)
  const ownVerified2 = await ruleVersion(org, 'AE-DU', true)
  const ownUnverified = await ruleVersion(org, 'AE-DU', false)
  const ownOtherJurisdiction = await ruleVersion(org, 'AE-AZ', true)
  const sharedCompatible = await ruleVersion(null, 'ae-du', true)
  const sharedIncompatible = await ruleVersion(null, 'AE-AZ', true)
  const foreign = await ruleVersion(otherOrg, 'AE-DU', true)

  section('T05–T08 create a pack; ownership is server-derived; blanks and duplicates rejected')
  const created = await A.send('POST', `/api/organizations/${org}/rule-packs`, { packKey: `${tag}-PACK`, displayName: 'Dubai claims pack', jurisdictionCode: 'AE-DU' })
  check('T05 create organization pack -> 201', created.status === 201, JSON.stringify(created.body))
  check('T05 organizationId and ownershipScope are derived from the route', created.body?.organizationId === org && created.body?.ownershipScope === 'ORGANIZATION')
  const packId = created.body.id as string

  {
    const before = await prisma.rulePack.count()
    const forgedOrg = await A.send('POST', `/api/organizations/${org}/rule-packs`, { packKey: `${tag}-F1`, displayName: 'x', jurisdictionCode: 'AE-DU', organizationId: otherOrg })
    const forgedScope = await A.send('POST', `/api/organizations/${org}/rule-packs`, { packKey: `${tag}-F2`, displayName: 'x', jurisdictionCode: 'AE-DU', ownershipScope: 'SYSTEM_SHARED' })
    check('T06 a client-supplied organizationId is rejected (400)', forgedOrg.status === 400, String(forgedOrg.status))
    check('T06 a client-supplied ownershipScope is rejected (400)', forgedScope.status === 400, String(forgedScope.status))
    check('T06 neither forged request created a pack', (await prisma.rulePack.count()) === before)
  }

  for (const [label, body] of [
    ['packKey', { packKey: '  ', displayName: 'x', jurisdictionCode: 'AE-DU' }],
    ['displayName', { packKey: `${tag}-B2`, displayName: '', jurisdictionCode: 'AE-DU' }],
    ['jurisdictionCode', { packKey: `${tag}-B3`, displayName: 'x' }],
  ] as const) {
    const res = await A.send('POST', `/api/organizations/${org}/rule-packs`, body)
    check(`T07 blank ${label} -> 400`, res.status === 400, String(res.status))
  }

  {
    const auditBefore = await auditCount()
    const dup = await A.send('POST', `/api/organizations/${org}/rule-packs`, { packKey: `${tag}-PACK`, displayName: 'again', jurisdictionCode: 'AE-DU' })
    check('T08 duplicate packKey in the same organization -> 400', dup.status === 400 && dup.body?.error?.code === 'VALIDATION_ERROR', JSON.stringify(dup.body))
    check('T08 the rejected duplicate wrote no AuditEvent', (await auditCount()) === auditBefore)
    // SYSTEM_SHARED packs have no tenant write route, so the null scope is proven at the database.
    await prisma.rulePack.create({ data: { organizationId: null, ownershipScope: 'SYSTEM_SHARED', packKey: `${tag}-SHARED`, displayName: 's', jurisdictionCode: 'AE-DU' } })
    let sharedDuplicateRejected = false
    try {
      await prisma.rulePack.create({ data: { organizationId: null, ownershipScope: 'SYSTEM_SHARED', packKey: `${tag}-SHARED`, displayName: 's2', jurisdictionCode: 'AE-AZ' } })
    } catch (error) {
      sharedDuplicateRejected = String(error).includes('rule_packs_scope_pack_key_uq') || String(error).includes('Unique constraint')
    }
    check('T08 a duplicate SYSTEM_SHARED packKey (NULL scope) is rejected by NULLS NOT DISTINCT', sharedDuplicateRejected)
    const sameKeyOtherOrg = await prisma.rulePack.create({ data: { organizationId: otherOrg, ownershipScope: 'ORGANIZATION', packKey: `${tag}-PACK`, displayName: 'other', jurisdictionCode: 'AE-DU' } })
    check('T08 the same packKey in another organization is a different scope', !!sameKeyOtherOrg.id)
    let ownershipCheckFired = false
    try {
      await prisma.rulePack.create({ data: { organizationId: null, ownershipScope: 'ORGANIZATION', packKey: `${tag}-BAD`, displayName: 'b', jurisdictionCode: 'AE-DU' } })
    } catch (error) {
      ownershipCheckFired = String(error).includes('rule_packs_ownership_scope_chk')
    }
    check('ownership CHECK: ORGANIZATION with a NULL organization is refused by PostgreSQL', ownershipCheckFired)
  }

  section('T09–T13 roles, tenancy and stable identity')
  {
    const write = await V.send('POST', `/api/organizations/${org}/rule-packs`, { packKey: `${tag}-V`, displayName: 'v', jurisdictionCode: 'AE-DU' })
    const patch = await V.send('PATCH', `/api/rule-packs/${packId}`, { displayName: 'viewer edit' })
    check('T09 viewer create -> 403', write.status === 403, String(write.status))
    check('T09 viewer patch -> 403', patch.status === 403, String(patch.status))
    const list = await V.get(`/api/organizations/${org}/rule-packs`)
    const one = await V.get(`/api/rule-packs/${packId}`)
    check('T10 viewer list -> 200', list.status === 200 && Array.isArray(list.body?.items), String(list.status))
    check('T10 viewer read -> 200', one.status === 200 && one.body?.id === packId, String(one.status))

    const otherPack = await prisma.rulePack.findFirstOrThrow({ where: { organizationId: otherOrg, packKey: `${tag}-PACK` } })
    const crossRead = await A.get(`/api/rule-packs/${otherPack.id}`)
    const crossList = await A.get(`/api/organizations/${otherOrg}/rule-packs`)
    check('T11 cross-tenant pack read is denied without disclosing content (403)', crossRead.status === 403 && !crossRead.body?.packKey, String(crossRead.status))
    check('T11 cross-tenant pack list is denied (403)', crossList.status === 403, String(crossList.status))
    const sharedPack = await prisma.rulePack.findFirstOrThrow({ where: { organizationId: null, packKey: `${tag}-SHARED` } })
    const sharedWrite = await A.send('PATCH', `/api/rule-packs/${sharedPack.id}`, { displayName: 'tenant edit' })
    check('no tenant write path to a SYSTEM_SHARED pack (404, existing shared policy)', sharedWrite.status === 404, String(sharedWrite.status))
    const unknown = await A.get('/api/rule-packs/00000000-0000-4000-8000-000000000000')
    check('an unknown pack id is a 404', unknown.status === 404)
  }
  {
    const auditBefore = await auditCount()
    const rename = await A.send('PATCH', `/api/rule-packs/${packId}`, { displayName: 'Dubai claims pack (renamed)' })
    check('T12 PATCH displayName -> 200', rename.status === 200 && rename.body?.displayName === 'Dubai claims pack (renamed)', JSON.stringify(rename.body))
    const events = await prisma.auditEvent.findMany({ where: { entityId: packId, actionCode: 'rule_pack.updated' } })
    check('T12 exactly one rule_pack.updated AuditEvent', events.length === 1 && (await auditCount()) === auditBefore + 1)
    for (const [field, value] of [
      ['packKey', 'CHANGED'],
      ['jurisdictionCode', 'AE-AZ'],
      ['organizationId', otherOrg],
      ['ownershipScope', 'SYSTEM_SHARED'],
    ] as const) {
      const before = await auditCount()
      const res = await A.send('PATCH', `/api/rule-packs/${packId}`, { [field]: value })
      check(`T13 PATCH ${field} -> 400 with no AuditEvent`, res.status === 400 && (await auditCount()) === before, String(res.status))
    }
    const stored = await prisma.rulePack.findUniqueOrThrow({ where: { id: packId } })
    check('T13 the stored identity is unchanged', stored.packKey === `${tag}-PACK` && stored.jurisdictionCode === 'AE-DU' && stored.organizationId === org && stored.ownershipScope === 'ORGANIZATION')
  }

  section('T14–T17 versions and draft dates')
  const v1 = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v1', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' })
  check('T14 create version -> 201 UNVERIFIED / INACTIVE', v1.status === 201 && v1.body?.verificationStatus === 'UNVERIFIED' && v1.body?.activationStatus === 'INACTIVE', JSON.stringify(v1.body))
  const v1Id = v1.body.id as string
  {
    const forged = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'vx', verificationStatus: 'VERIFIED' })
    check('T14 a client-supplied lifecycle field is rejected (400)', forged.status === 400, String(forged.status))
    const dup = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v1' })
    check('T15 duplicate version -> 400', dup.status === 400, String(dup.status))
    const inverted = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v-bad', effectiveFrom: '2026-12-31', effectiveTo: '2026-01-01' })
    const impossible = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v-bad2', effectiveFrom: '2026-02-31' })
    check('T16 inverted dates -> 400', inverted.status === 400, String(inverted.status))
    check('T16 an impossible calendar date -> 400', impossible.status === 400, String(impossible.status))
    const patch = await A.send('PATCH', `/api/rule-pack-versions/${v1Id}`, { effectiveTo: '2026-11-30' })
    check('T17 draft date patch -> 200', patch.status === 200 && patch.body?.effectiveTo === '2026-11-30', JSON.stringify(patch.body))
    const patchInverted = await A.send('PATCH', `/api/rule-pack-versions/${v1Id}`, { effectiveFrom: '2027-01-01' })
    check('T16 a date patch that would invert the period -> 400', patchInverted.status === 400, String(patchInverted.status))
    const patchStatus = await A.send('PATCH', `/api/rule-pack-versions/${v1Id}`, { activationStatus: 'ACTIVE' })
    check('only dates are patchable (lifecycle field -> 400)', patchStatus.status === 400, String(patchStatus.status))
  }

  section('T18–T23 membership')
  const memberPath = `/api/rule-pack-versions/${v1Id}/members`
  const add = await A.send('POST', memberPath, { ruleVersionId: ownVerified.id })
  check('T18 add own verified RuleVersion -> 201', add.status === 201 && add.body?.ruleVersionId === ownVerified.id, JSON.stringify(add.body))
  const sharedAdd = await A.send('POST', memberPath, { ruleVersionId: sharedCompatible.id })
  check('T19 a compatible SYSTEM_SHARED RuleVersion -> 201', sharedAdd.status === 201, String(sharedAdd.status))
  const sharedBad = await A.send('POST', memberPath, { ruleVersionId: sharedIncompatible.id })
  check('T19 an incompatible-jurisdiction SYSTEM_SHARED RuleVersion -> 400', sharedBad.status === 400, String(sharedBad.status))
  {
    const before = await prisma.rulePackMember.count({ where: { rulePackVersionId: v1Id } })
    const auditBefore = await auditCount()
    const foreignAdd = await A.send('POST', memberPath, { ruleVersionId: foreign.id })
    check('T20 another organization RuleVersion -> 403, nothing written', foreignAdd.status === 403 && (await prisma.rulePackMember.count({ where: { rulePackVersionId: v1Id } })) === before && (await auditCount()) === auditBefore, String(foreignAdd.status))
    const wrongJurisdiction = await A.send('POST', memberPath, { ruleVersionId: ownOtherJurisdiction.id })
    check('T21 jurisdiction mismatch -> 400', wrongJurisdiction.status === 400, String(wrongJurisdiction.status))
    const dup = await A.send('POST', memberPath, { ruleVersionId: ownVerified.id })
    check('T22 duplicate member -> 400', dup.status === 400, String(dup.status))
    const withSource = await A.send('POST', memberPath, { ruleVersionId: ownVerified2.id, sourceVersionId: foreign.id })
    check('a member takes only ruleVersionId: an extra source/context field -> 400', withSource.status === 400, String(withSource.status))
  }
  {
    const unverifiedAdd = await A.send('POST', memberPath, { ruleVersionId: ownUnverified.id })
    check('a draft may hold an unverified RuleVersion (201)', unverifiedAdd.status === 201, String(unverifiedAdd.status))
    const removable = unverifiedAdd.body.id as string
    const auditBefore = await auditCount()
    const removed = await A.del(`/api/rule-pack-members/${removable}`)
    const removedEvents = await prisma.auditEvent.findMany({ where: { entityId: removable, actionCode: 'rule_pack_member.removed' } })
    check('T23 remove a draft member -> 200 + rule_pack_member.removed', removed.status === 200 && removedEvents.length === 1 && (await auditCount()) === auditBefore + 1, String(removed.status))
    check('T23 the member row is gone', (await prisma.rulePackMember.findUnique({ where: { id: removable } })) === null)
  }

  section('T24–T28 verification freeze')
  {
    const empty = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v-empty' })
    const verifyEmpty = await A.send('POST', `/api/rule-pack-versions/${empty.body.id}/verification`, {})
    check('T24 verify an empty version -> 400', verifyEmpty.status === 400, String(verifyEmpty.status))

    const withUnverified = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v-unverified' })
    await A.send('POST', `/api/rule-pack-versions/${withUnverified.body.id}/members`, { ruleVersionId: ownUnverified.id })
    const auditBefore = await auditCount()
    const verifyUnverified = await A.send('POST', `/api/rule-pack-versions/${withUnverified.body.id}/verification`, {})
    check('T25 verify with an unverified member -> 400, no AuditEvent', verifyUnverified.status === 400 && (await auditCount()) === auditBefore, String(verifyUnverified.status))
  }
  const verified = await A.send('POST', `/api/rule-pack-versions/${v1Id}/verification`, {})
  check('T26 verify a valid snapshot -> VERIFIED with verifiedAt', verified.status === 200 && verified.body?.verificationStatus === 'VERIFIED' && !!verified.body?.verifiedAt, JSON.stringify(verified.body))
  {
    const before = await auditCount()
    const addAfter = await A.send('POST', memberPath, { ruleVersionId: ownVerified2.id })
    const memberId = (await prisma.rulePackMember.findFirstOrThrow({ where: { rulePackVersionId: v1Id } })).id
    const removeAfter = await A.del(`/api/rule-pack-members/${memberId}`)
    const datesAfter = await A.send('PATCH', `/api/rule-pack-versions/${v1Id}`, { effectiveTo: '2026-12-31' })
    const reverify = await A.send('POST', `/api/rule-pack-versions/${v1Id}/verification`, {})
    check('T27 post-verification member add -> 400', addAfter.status === 400, String(addAfter.status))
    check('T27 post-verification member remove -> 400', removeAfter.status === 400, String(removeAfter.status))
    check('T28 post-verification date patch -> 400', datesAfter.status === 400, String(datesAfter.status))
    check('a VERIFIED snapshot cannot be verified again -> 400', reverify.status === 400, String(reverify.status))
    check('T27/T28 none of the rejected mutations wrote an AuditEvent', (await auditCount()) === before)
    const stored = await prisma.rulePackVersion.findUniqueOrThrow({ where: { id: v1Id } })
    check('T28 the frozen dates are unchanged', stored.effectiveTo?.toISOString().slice(0, 10) === '2026-11-30')
  }

  section('T29–T35 activation, supersession, history')
  const v1Members = (await prisma.rulePackMember.findMany({ where: { rulePackVersionId: v1Id } })).map((m) => m.ruleVersionId).sort()
  {
    const draftVersion = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: 'v-draft' })
    const activateDraft = await A.send('POST', `/api/rule-pack-versions/${draftVersion.body.id}/activate`, { businessDate: '2026-06-01' })
    check('T29 activate an UNVERIFIED version -> 400', activateDraft.status === 400, String(activateDraft.status))
    const outside = await A.send('POST', `/api/rule-pack-versions/${v1Id}/activate`, { businessDate: '2027-06-01' })
    check('activation with a businessDate outside the period -> 400', outside.status === 400, String(outside.status))
    const noDate = await A.send('POST', `/api/rule-pack-versions/${v1Id}/activate`, {})
    check('activation requires a real businessDate -> 400', noDate.status === 400, String(noDate.status))
  }
  const activated = await A.send('POST', `/api/rule-pack-versions/${v1Id}/activate`, { businessDate: '2026-06-01' })
  check('T30 activate a VERIFIED version -> ACTIVE with activatedAt', activated.status === 200 && activated.body?.activationStatus === 'ACTIVE' && !!activated.body?.activatedAt, JSON.stringify(activated.body))

  // A successor: v10 is created and activated BEFORE v2; then v2 is activated. Current is whichever
  // was explicitly activated last — the labels and creation order never decide.
  async function verifiedVersion(label: string) {
    const v = await A.send('POST', `/api/rule-packs/${packId}/versions`, { version: label, effectiveFrom: '2026-01-01' })
    await A.send('POST', `/api/rule-pack-versions/${v.body.id}/members`, { ruleVersionId: ownVerified2.id })
    await A.send('POST', `/api/rule-pack-versions/${v.body.id}/verification`, {})
    return v.body.id as string
  }
  const v10Id = await verifiedVersion('v10')
  const v2Id = await verifiedVersion('v2')
  {
    const auditBefore = await auditCount()
    const act10 = await A.send('POST', `/api/rule-pack-versions/${v10Id}/activate`, { businessDate: '2026-06-01' })
    const oldV1 = await prisma.rulePackVersion.findUniqueOrThrow({ where: { id: v1Id } })
    check('T32 activating a successor supersedes the old ACTIVE version', act10.status === 200 && oldV1.activationStatus === 'SUPERSEDED' && !!oldV1.supersededAt, JSON.stringify({ status: act10.status, old: oldV1.activationStatus }))
    const superseded = await prisma.auditEvent.findMany({ where: { entityId: v1Id, actionCode: 'rule_pack_version.superseded' } })
    check('T32 superseded + activated AuditEvents, atomically (exactly two new events)', superseded.length === 1 && (await auditCount()) === auditBefore + 2)
    const v1MembersAfter = (await prisma.rulePackMember.findMany({ where: { rulePackVersionId: v1Id } })).map((m) => m.ruleVersionId).sort()
    check('T32 the superseded version keeps its exact membership', JSON.stringify(v1MembersAfter) === JSON.stringify(v1Members))
    const act2 = await A.send('POST', `/api/rule-pack-versions/${v2Id}/activate`, { businessDate: '2026-06-01' })
    const [s10, s2] = await Promise.all([
      prisma.rulePackVersion.findUniqueOrThrow({ where: { id: v10Id } }),
      prisma.rulePackVersion.findUniqueOrThrow({ where: { id: v2Id } }),
    ])
    check('T33 v2 activated after v10 is current; v10 is SUPERSEDED — no lexical or creation-order rank', act2.status === 200 && s2.activationStatus === 'ACTIVE' && s10.activationStatus === 'SUPERSEDED', JSON.stringify({ v2: s2.activationStatus, v10: s10.activationStatus }))
    const reactivate = await A.send('POST', `/api/rule-pack-versions/${v1Id}/activate`, { businessDate: '2026-06-01' })
    check('a SUPERSEDED version is history and cannot be reactivated -> 400', reactivate.status === 400, String(reactivate.status))
  }
  {
    const activeCount = await prisma.rulePackVersion.count({ where: { rulePackId: packId, activationStatus: 'ACTIVE' } })
    check('T31 exactly one ACTIVE version exists for the pack', activeCount === 1, String(activeCount))
    let raceGuard = false
    try {
      await prisma.rulePackVersion.update({ where: { id: v10Id }, data: { activationStatus: 'ACTIVE', supersededAt: null } })
    } catch (error) {
      raceGuard = String(error).includes('rule_pack_versions_one_active_uq') || String(error).includes('Unique constraint')
    }
    check('T31 PostgreSQL refuses a second ACTIVE version (partial unique index)', raceGuard)
  }
  {
    const history = await A.get(`/api/rule-pack-versions/${v1Id}`)
    const historyMembers = await A.get(`/api/rule-pack-versions/${v1Id}/members`)
    const viewerHistory = await V.get(`/api/rule-pack-versions/${v1Id}/members`)
    check('T34 the SUPERSEDED version is readable', history.status === 200 && history.body?.activationStatus === 'SUPERSEDED')
    check('T34 its members are readable and unchanged', historyMembers.status === 200 && JSON.stringify(historyMembers.body.items.map((m: { ruleVersionId: string }) => m.ruleVersionId).sort()) === JSON.stringify(v1Members))
    check('T34 a viewer can read the history too', viewerHistory.status === 200)
    const listVersions = await A.get(`/api/rule-packs/${packId}/versions`)
    check('all versions are listed for historical retrieval', listVersions.status === 200 && listVersions.body.items.length >= 6)
  }
  {
    const auditBefore = await auditCount()
    const delVersion = await A.del(`/api/rule-pack-versions/${v1Id}`)
    const delPack = await A.del(`/api/rule-packs/${packId}`)
    check('T35 there is no rule pack version DELETE route (404)', delVersion.status === 404, String(delVersion.status))
    check('T35 there is no rule pack DELETE route (404)', delPack.status === 404, String(delPack.status))
    check('T35 the version still exists and nothing was audited', !!(await prisma.rulePackVersion.findUnique({ where: { id: v1Id } })) && (await auditCount()) === auditBefore)
  }
  {
    const provenanceRoute = await A.send('POST', '/api/provenance/evaluate', {})
    const provenanceRoute2 = await A.send('POST', `/api/rule-definitions/00000000-0000-4000-8000-000000000000/provenance/evaluate`, {})
    check('T52 no /provenance/evaluate endpoint exists (404)', provenanceRoute.status === 404 && provenanceRoute2.status === 404, `${provenanceRoute.status}/${provenanceRoute2.status}`)
  }

  console.log(`\n[a3.9-http] ${passed} passed, ${failed} failed`)
  console.log(failed === 0 ? '[a3.9-http] ALL CHECKS PASS' : '[a3.9-http] CHECKS FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main()
  .catch((error) => {
    console.error('[a3.9-http] uncaught error (this itself is a FAIL):', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
