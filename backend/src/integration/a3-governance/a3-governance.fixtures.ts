import { callApi } from '../a1-foundation/integration.http.ts'

// A3.10 — synthetic fixtures built ONLY through the existing owner routes (§8: acceptance must
// reuse owner boundaries, not construct governed state behind them). Every helper here is a thin
// HTTP call to the module that already owns that object; nothing validates, decides or persists on
// its own. A fixture that the API rejects throws immediately, so a broken setup can never be
// mistaken for a scenario result.
//
// Direct database access is deliberately NOT used here. It remains only for read-only structural
// checks and for the one explicitly marked cross-tenant adversarial fixture in the harness, where
// bypassing the owner boundary is the point of the test.

export type ApiFixtures = ReturnType<typeof apiFixtures>

type Json = Record<string, unknown>

export function apiFixtures(baseUrl: string, cookie: string, organizationId: string, tag: string) {
  let counter = 0
  const next = (name: string) => `${tag}-${++counter}-${name}`

  async function call(method: string, path: string, body?: Json, expected = 201): Promise<any> {
    const res = await callApi(baseUrl, path, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status !== expected)
      throw new Error(`fixture ${method} ${path} expected ${expected}, got ${res.status}: ${JSON.stringify(res.body)?.slice(0, 300)}`)
    return res.body
  }

  const post = (path: string, body?: Json, expected = 201) => call('POST', path, body, expected)
  const patch = (path: string, body: Json) => call('PATCH', path, body, 200)
  const action = (path: string, body?: Json) => call('POST', path, body, 200)

  // ---- A2 masters and REF-01 commercial identity ------------------------------------------
  const payer = () => post(`/api/organizations/${organizationId}/payers`, { displayName: next('payer') })
  const tpa = () => post(`/api/organizations/${organizationId}/tpas`, { displayName: next('tpa') })
  const network = () => post(`/api/organizations/${organizationId}/networks`, { displayName: next('network') })
  const service = () => post(`/api/organizations/${organizationId}/services`, { internalCode: next('svc'), displayName: 'A3.10 service' })
  const procedureCode = () => post(`/api/organizations/${organizationId}/procedure-codes`, { internalCode: next('proc'), displayName: 'A3.10 procedure' })
  const diagnosisCode = () => post(`/api/organizations/${organizationId}/diagnosis-codes`, { code: next('dx'), displayName: 'A3.10 diagnosis' })
  const facility = () => post(`/api/organizations/${organizationId}/facilities`, { name: next('facility') })

  async function regulatoryProfile(facilityId: string, jurisdictionCode: string, effectiveFrom: string, effectiveTo: string | null = null) {
    const profile = await post(`/api/facilities/${facilityId}/regulatory-profiles`, {
      jurisdictionCode,
      regulatoryAuthorityCode: jurisdictionCode === 'AE-DU' ? 'DHA' : 'DOH',
      effectiveFrom,
      effectiveTo,
    })
    return action(`/api/facility-regulatory-profiles/${profile.id}/activate`)
  }

  async function commercialChain(facilityId: string | null = null) {
    const [payerRow, tpaRow, networkRow] = [await payer(), await tpa(), await network()]
    const insuranceProduct = await post(`/api/organizations/${organizationId}/insurance-products`, {
      payerId: payerRow.id,
      productCode: next('prod'),
      displayName: 'A3.10 product',
    })
    await post(`/api/insurance-products/${insuranceProduct.id}/product-networks`, { networkId: networkRow.id })
    const providerContract = await post(`/api/organizations/${organizationId}/provider-contracts`, {
      contractKey: next('contract'),
      displayName: 'A3.10 contract',
      payerId: payerRow.id,
      tpaId: tpaRow.id,
      networkId: networkRow.id,
      insuranceProductId: insuranceProduct.id,
      effectiveFrom: '2020-01-01',
    })
    if (facilityId) await post(`/api/provider-contracts/${providerContract.id}/contract-facilities`, { facilityId })
    const tariffSchedule = await post(`/api/provider-contracts/${providerContract.id}/tariff-schedules`, {
      tariffKey: next('tariff'),
      displayName: 'A3.10 tariff',
    })
    const tariffScheduleVersion = await post(`/api/tariff-schedules/${tariffSchedule.id}/versions`, {
      version: '1',
      effectiveFrom: '2020-01-01',
      effectiveTo: null,
    })
    return {
      payer: payerRow,
      tpa: tpaRow,
      network: networkRow,
      insuranceProduct,
      providerContract,
      tariffSchedule,
      tariffScheduleVersion,
      service: await service(),
      procedureCode: await procedureCode(),
      diagnosisCode: await diagnosisCode(),
    }
  }

  // ---- A3.1–A3.3 source, evidence, interpretation and lifecycle -----------------------------
  type SourceOptions = {
    category?: string
    jurisdictionCode?: string
    publicationDate?: string | null
    effectiveFrom?: string | null
    effectiveTo?: string | null
    // Omit to leave the version INACTIVE (a legitimate "not in force" fixture).
    activateOn?: string | null
  }

  async function verifiedSource(name: string, options: SourceOptions = {}) {
    const jurisdictionCode = options.jurisdictionCode ?? 'AE-DU'
    const source = await post(`/api/organizations/${organizationId}/rule-sources`, {
      jurisdictionCode,
      issuingAuthority: 'Synthetic Authority',
      sourceCategory: options.category ?? 'REGULATORY_AUTHORITY',
      referenceNumber: next(name),
      title: `A3.10 ${name}`,
    })
    const version = await post(`/api/rule-sources/${source.id}/versions`, {
      version: '1',
      rawEvidenceRef: `synthetic-evidence://a3-10/${next(name)}`,
    })
    await patch(`/api/rule-source-versions/${version.id}/lifecycle`, {
      publicationDate: options.publicationDate === undefined ? '2020-01-01' : options.publicationDate,
      effectiveFrom: options.effectiveFrom === undefined ? '2020-01-01' : options.effectiveFrom,
      effectiveTo: options.effectiveTo ?? null,
    })
    await action(`/api/rule-source-versions/${version.id}/publish`)
    const verified = await action(`/api/rule-source-versions/${version.id}/verification`, { verificationStatus: 'VERIFIED' })
    const interpretation = await post(`/api/rule-source-versions/${version.id}/interpretations`, {
      interpretationVersion: next('interp'),
      normalizedInterpretationRef: `synthetic-interpretation://a3-10/${next(name)}`,
    })
    await patch(`/api/source-interpretations/${interpretation.id}`, { verificationStatus: 'VERIFIED' })
    let activated = verified
    if (options.activateOn !== null && options.activateOn !== undefined)
      activated = await action(`/api/rule-source-versions/${version.id}/activate`, { businessDate: options.activateOn, jurisdictionCode })
    return { source, sourceVersion: { ...version, ...activated }, interpretation }
  }

  const suspendSourceVersion = (sourceVersionId: string) => action(`/api/rule-source-versions/${sourceVersionId}/suspend`)
  // Activating a version is also how A3.3/A3.4 supersede the versions it SUPERSEDES.
  const activateSourceVersion = (sourceVersionId: string, businessDate: string, jurisdictionCode = 'AE-DU') =>
    action(`/api/rule-source-versions/${sourceVersionId}/activate`, { businessDate, jurisdictionCode })
  const relate = (fromSourceVersionId: string, toSourceVersionId: string, relationshipType: string) =>
    post(`/api/rule-source-versions/${fromSourceVersionId}/relationships`, { toSourceVersionId, relationshipType })

  // ---- A3.5–A3.7 rule identity, applicability and bindings ----------------------------------
  const ruleDefinition = (name: string, jurisdictionCode = 'AE-DU') =>
    post(`/api/organizations/${organizationId}/rule-definitions`, { ruleKey: next(name), displayName: `A3.10 ${name}`, jurisdictionCode })

  const draftRuleVersion = (
    ruleId: string,
    version: string,
    options: { effectType?: string; effectiveFrom?: string | null; effectiveTo?: string | null } = {},
  ) =>
    post(`/api/rule-definitions/${ruleId}/versions`, {
      version,
      effectType: options.effectType ?? 'AUTHORIZATION_REQUIREMENT_EFFECT',
      effectiveFrom: options.effectiveFrom === undefined ? '2020-01-01' : options.effectiveFrom,
      effectiveTo: options.effectiveTo ?? null,
    })

  // An all-null applicability row matches every context; A3.6 owns what that means.
  const applicability = (ruleVersionId: string, dimensions: Record<string, string | null> = {}) =>
    post(`/api/rule-versions/${ruleVersionId}/applicabilities`, dimensions)

  const bind = (ruleVersionId: string, sourceInterpretationId: string, sourceRole = 'GOVERNING') =>
    post(`/api/rule-versions/${ruleVersionId}/source-bindings`, { sourceInterpretationId, sourceRole })

  // Verification freezes applicability and bindings (H05), so it is always the last step.
  const verifyRuleVersion = (ruleVersionId: string) =>
    action(`/api/rule-versions/${ruleVersionId}/verification`, { verificationStatus: 'VERIFIED' })

  return {
    payer,
    tpa,
    network,
    service,
    procedureCode,
    diagnosisCode,
    facility,
    regulatoryProfile,
    commercialChain,
    verifiedSource,
    suspendSourceVersion,
    activateSourceVersion,
    relate,
    ruleDefinition,
    draftRuleVersion,
    applicability,
    bind,
    verifyRuleVersion,
  }
}
