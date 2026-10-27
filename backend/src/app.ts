import express from 'express'
import { toNodeHandler } from 'better-auth/node'
import { auth } from './shared/auth/auth.ts'
import { requestIdMiddleware } from './shared/http/request-id.middleware.ts'
import { apiNotFoundHandler, apiErrorHandler } from './shared/errors/error.middleware.ts'
import healthRouter from './routes/health.route.ts'
import readyRouter from './routes/ready.route.ts'
import organizationRouter from './modules/organization/organization.route.ts'
import { organizationFacilityRouter, facilityRouter } from './modules/facility/facility.route.ts'
import meRouter from './routes/me.route.ts'
import accessRouter from './modules/access/access.route.ts'
import { auditRouter } from './modules/audit/audit.route.ts'
import { organizationClinicianRouter, clinicianRouter } from './modules/clinician/clinician.route.ts'
import { organizationSpecialtyRouter, specialtyRouter } from './modules/specialty/specialty.route.ts'
import { organizationPayerRouter, payerRouter } from './modules/payer/payer.route.ts'
import { organizationTpaRouter, tpaRouter } from './modules/tpa/tpa.route.ts'
import { organizationNetworkRouter, networkRouter } from './modules/network/network.route.ts'
import { organizationServiceRouter, serviceRouter } from './modules/service/service.route.ts'
import { organizationProcedureCodeRouter, procedureCodeRouter } from './modules/procedure-code/procedure-code.route.ts'
import { organizationDiagnosisCodeRouter, diagnosisCodeRouter } from './modules/diagnosis-code/diagnosis-code.route.ts'
import { organizationExternalIdentifierRouter, externalIdentifierRouter } from './modules/external-identifier/external-identifier.route.ts'
import { organizationRuleSourceRouter, ruleSourceRouter } from './modules/rule-source/rule-source.route.ts'
import { sourceVersionsRouter, ruleSourceVersionRouter } from './modules/rule-source-version/rule-source-version.route.ts'
import { versionInterpretationsRouter, sourceInterpretationRouter } from './modules/source-interpretation/source-interpretation.route.ts'
import { versionRelationshipsRouter, ruleSourceRelationshipRouter } from './modules/rule-source-relationship/rule-source-relationship.route.ts'
import { organizationRuleDefinitionRouter, ruleDefinitionRouter } from './modules/rule-definition/rule-definition.route.ts'
import { ruleVersionsForRuleRouter, ruleVersionRouter } from './modules/rule-version/rule-version.route.ts'
import { versionApplicabilitiesRouter, ruleApplicabilityRouter } from './modules/rule-applicability/rule-applicability.route.ts'
import { versionSourceBindingsRouter, ruleSourceBindingRouter } from './modules/rule-source-binding/rule-source-binding.route.ts'
import { facilityRegulatoryProfilesRouter, facilityRegulatoryProfileRouter } from './modules/facility-regulatory/facility-regulatory.route.ts'
import { organizationInsuranceProductRouter, insuranceProductRouter, productNetworkRouter } from './modules/commercial-coverage/insurance-product.route.ts'
import { organizationProviderContractRouter, providerContractRouter, contractFacilityRouter } from './modules/commercial-coverage/provider-contract.route.ts'
import { providerContractTariffSchedulesRouter, tariffScheduleRouter, tariffScheduleVersionRouter } from './modules/commercial-coverage/tariff-schedule.route.ts'
import { referenceDatasetRouter, referenceDatasetVersionRouter } from './modules/reference-dataset/reference-dataset.route.ts'
import { sourceScopesRouter, ruleSourceScopeRouter } from './modules/rule-source-scope/rule-source-scope.route.ts'
import { ruleDefinitionResolutionRouter } from './modules/rule-resolution/rule-resolution.route.ts'
import {
  organizationRulePackRouter,
  rulePackMemberRouter,
  rulePackRouter,
  rulePackVersionRouter,
} from './modules/rule-pack/rule-pack.route.ts'
import { organizationPatientRouter, patientRouter } from './modules/patient/patient.route.ts'
import {
  clinicianAssignmentRouter,
  facilityAssignmentRouter,
  specialtyAssignmentRouter,
} from './modules/clinician-assignment/clinician-assignment.route.ts'
import {
  insuranceMembershipRouter,
  patientInsuranceMembershipRouter,
} from './modules/insurance-membership/insurance-membership.route.ts'
import { encounterRouter, patientEncounterRouter } from './modules/encounter/encounter.route.ts'
import { encounterDiagnosesRouter, encounterDiagnosisRouter } from './modules/encounter-diagnosis/encounter-diagnosis.route.ts'
import { encounterActivitiesRouter, encounterActivityRouter } from './modules/encounter-activity/encounter-activity.route.ts'
import { encounterObservationsRouter, encounterObservationRouter } from './modules/encounter-observation/encounter-observation.route.ts'
import { encounterBillingContextRouter } from './modules/encounter-billing-context/encounter-billing-context.route.ts'
import {
  organizationEvidenceArtifactRouter,
  evidenceArtifactRouter,
  evidenceArtifactVersionRouter,
} from './modules/evidence-artifact/evidence-artifact.route.ts'
import {
  encounterEligibilityVerificationRouter,
  eligibilityVerificationRouter,
} from './modules/eligibility-verification/eligibility-verification.route.ts'
import {
  encounterPriorAuthorizationRouter,
  priorAuthorizationRouter,
  priorAuthorizationVersionRouter,
} from './modules/prior-authorization/prior-authorization.route.ts'
import { authorizationLineRouter, versionAuthorizationLineRouter } from './modules/authorization-line/authorization-line.route.ts'
import { encounterPreClaimCommercialContextRouter } from './modules/pre-claim-commercial-context/pre-claim-commercial-context.route.ts'
import { encounterEvidenceCompletenessRouter, ruleVersionEvidenceRequirementRouter } from './modules/evidence-requirement/evidence-requirement.route.ts'
import { encounterEvidenceLinkRouter, encounterEvidenceLinksRouter } from './modules/encounter-evidence/encounter-evidence.route.ts'
import { encounterValidationRunsRouter, validationFindingRouter, validationRunRouter } from './modules/validation-run/validation-run.route.ts'
import { encounterPreClaimValidationRouter } from './modules/pre-claim-validation/pre-claim-validation.route.ts'
import { encounterReadinessRouter, readinessAssessmentRouter, validationRunReadinessRouter } from './modules/pre-claim-readiness/pre-claim-readiness.route.ts'
import { assessmentClaimRouter, claimRouter, encounterClaimRouter } from './modules/claim/claim.route.ts'
import { claimLineRouter, claimLinesRouter } from './modules/claim-line/claim-line.route.ts'
import { claimDiagnosesRouter, claimDiagnosisRouter } from './modules/claim-diagnosis/claim-diagnosis.route.ts'
import { tariffRateRouter, tariffVersionRatesRouter } from './modules/tariff-rate/tariff-rate.route.ts'
import { claimPricingRunsRouter, pricingRunRouter } from './modules/claim-pricing/claim-pricing.route.ts'
import { claimDraftRouter, draftAssessmentRouter } from './modules/claim-draft/claim-draft.route.ts'
import { claimReviewRouter, reviewDecisionRouter } from './modules/claim-review/claim-review.route.ts'
import { claimPayloadRouter } from './modules/claim-payload/claim-payload.route.ts'
import { claimSubmissionRouter, frozenSubmissionRouter } from './modules/claim-submission/claim-submission.route.ts'
import { claimLifecycleRouter } from './modules/claim-lifecycle/claim-lifecycle.route.ts'
import { claimCorrectionRouter, correctionLinkRouter } from './modules/claim-correction/claim-correction.route.ts'
import { revenueEvidenceRouter, submissionRevenueEvidenceRouter } from './modules/revenue-evidence/revenue-evidence.route.ts'
import { classificationRouter, sourceClassificationRouter } from './modules/evidence-classification/evidence-classification.route.ts'
import { classificationReadinessRouter, readinessRouter } from './modules/evidence-gate/evidence-gate.route.ts'
import { caseRouter, submissionCaseRouter } from './modules/evidence-case/evidence-case.route.ts'
import { caseAssessmentRouter, prerequisiteAssessmentRouter } from './modules/case-prerequisite/case-prerequisite.route.ts'
import { basisTraceRouter } from './modules/closure-basis-trace/closure-basis-trace.route.ts'
import { timelineRouter } from './modules/revenue-timeline/revenue-timeline.route.ts'
import { deltaRouter } from './modules/revenue-delta/revenue-delta.route.ts'
import { continuityRouter } from './modules/revenue-continuity/revenue-continuity.route.ts'

export const app = express()

// A1.8 request correlation — response header only
app.use(requestIdMiddleware)

// A1.5 Better Auth must remain before express.json()
app.all('/api/auth/*splat', toNodeHandler(auth))

app.use(express.json())

// existing routes — keep order/contracts
app.use('/api', healthRouter)
app.use('/api/ready', readyRouter)
app.use('/api/organizations', organizationRouter)

// A1.4
app.use('/api/organizations', organizationFacilityRouter)
app.use('/api/facilities', facilityRouter)

// A1.5
app.use('/api', meRouter)

// A1.6
app.use('/api/access', accessRouter)

// A1.7
app.use('/api/organizations', auditRouter)

// A2.1
app.use('/api/organizations', organizationClinicianRouter)
app.use('/api/clinicians', clinicianRouter)

// A2.2
app.use('/api/organizations', organizationSpecialtyRouter)
app.use('/api/specialties', specialtyRouter)

// A2.3
app.use('/api/organizations', organizationPayerRouter)
app.use('/api/payers', payerRouter)

// A2.4
app.use('/api/organizations', organizationTpaRouter)
app.use('/api/tpas', tpaRouter)

// A2.5
app.use('/api/organizations', organizationNetworkRouter)
app.use('/api/networks', networkRouter)

// A2.6
app.use('/api/organizations', organizationServiceRouter)
app.use('/api/services', serviceRouter)

// A2.7
app.use('/api/organizations', organizationProcedureCodeRouter)
app.use('/api/procedure-codes', procedureCodeRouter)

// A2.8
app.use('/api/organizations', organizationDiagnosisCodeRouter)
app.use('/api/diagnosis-codes', diagnosisCodeRouter)

// A2.9
app.use('/api/organizations', organizationExternalIdentifierRouter)
app.use('/api/external-identifiers', externalIdentifierRouter)

// A3.1
app.use('/api/organizations', organizationRuleSourceRouter)
app.use('/api/rule-sources', ruleSourceRouter)

// A3.2
app.use('/api/rule-sources', sourceVersionsRouter)
app.use('/api/rule-source-versions', ruleSourceVersionRouter)
app.use('/api/rule-source-versions', versionInterpretationsRouter)
app.use('/api/source-interpretations', sourceInterpretationRouter)

// A3.4
app.use('/api/rule-source-versions', versionRelationshipsRouter)
app.use('/api/rule-source-relationships', ruleSourceRelationshipRouter)

// A3.5
app.use('/api/organizations', organizationRuleDefinitionRouter)
app.use('/api/rule-definitions', ruleDefinitionRouter)
app.use('/api/rule-definitions', ruleVersionsForRuleRouter)
app.use('/api/rule-versions', ruleVersionRouter)

// A3.6
app.use('/api/rule-versions', versionApplicabilitiesRouter)
app.use('/api/rule-applicabilities', ruleApplicabilityRouter)

// A3.7
app.use('/api/rule-versions', versionSourceBindingsRouter)
app.use('/api/rule-source-bindings', ruleSourceBindingRouter)

// REF-01 / R1
app.use('/api/facilities', facilityRegulatoryProfilesRouter)
app.use('/api/facility-regulatory-profiles', facilityRegulatoryProfileRouter)

// REF-01 / R2
app.use('/api/organizations', organizationInsuranceProductRouter)
app.use('/api/insurance-products', insuranceProductRouter)
app.use('/api/product-networks', productNetworkRouter)
app.use('/api/organizations', organizationProviderContractRouter)
app.use('/api/provider-contracts', providerContractRouter)
app.use('/api/provider-contracts', providerContractTariffSchedulesRouter)
app.use('/api/contract-facilities', contractFacilityRouter)
app.use('/api/tariff-schedules', tariffScheduleRouter)
app.use('/api/tariff-schedule-versions', tariffScheduleVersionRouter)

// REF-01 / R3
app.use('/api/reference-datasets', referenceDatasetRouter)
app.use('/api/reference-dataset-versions', referenceDatasetVersionRouter)

// REF-01 / R4
app.use('/api/rule-sources', sourceScopesRouter)
app.use('/api/rule-source-scopes', ruleSourceScopeRouter)

// A3.8
app.use('/api/rule-definitions', ruleDefinitionResolutionRouter)

// A3.9 — rule packs only. There is no provenance route: the A3-PROV-1 composer is internal.
app.use('/api/organizations', organizationRulePackRouter)
app.use('/api/rule-packs', rulePackRouter)
app.use('/api/rule-pack-versions', rulePackVersionRouter)
app.use('/api/rule-pack-members', rulePackMemberRouter)

// A4.1 — Patient identity and demographics (create / list / get / patch only; no delete).
app.use('/api/organizations', organizationPatientRouter)
app.use('/api/patients', patientRouter)

// A4.2 — effective-dated clinician practice assignments (create / list / get / close only).
app.use('/api/clinicians', clinicianAssignmentRouter)
app.use('/api/clinician-facility-assignments', facilityAssignmentRouter)
app.use('/api/clinician-specialty-assignments', specialtyAssignmentRouter)

// A4.3 — patient insurance membership registration (create / list / get / patch only; no delete).
app.use('/api/patients', patientInsuranceMembershipRouter)
app.use('/api/insurance-memberships', insuranceMembershipRouter)

// A4.4 — encounters with server-resolved provider/regulatory context (create / list / get / patch; no delete).
app.use('/api/patients', patientEncounterRouter)
app.use('/api/encounters', encounterRouter)

// A4.5 — ordered, correctable encounter diagnoses (add / list / reorder / remove; no delete).
app.use('/api/encounters', encounterDiagnosesRouter)
app.use('/api/encounter-diagnoses', encounterDiagnosisRouter)

// A4.6 — immutable encounter activity facts (add / list / get / remove; no patch, no delete).
app.use('/api/encounters', encounterActivitiesRouter)
app.use('/api/encounter-activities', encounterActivityRouter)

// A4.7 — typed, non-executable encounter observations (add / list / get / remove; no patch, no delete).
app.use('/api/encounters', encounterObservationsRouter)
app.use('/api/encounter-observations', encounterObservationRouter)
// A4.9 - one read-only aggregate: GET /api/encounters/:encounterId/billing-context
app.use('/api/encounters', encounterBillingContextRouter)
// A5.1 - evidence identity and its append-only versions. No PATCH, DELETE or content route.
app.use('/api/organizations', organizationEvidenceArtifactRouter)
app.use('/api/evidence-artifacts', evidenceArtifactRouter)
app.use('/api/evidence-artifact-versions', evidenceArtifactVersionRouter)

// A5.2 - immutable, evidence-bearing eligibility verifications. Three routes, all GET or POST:
// no PATCH, no DELETE, and deliberately no /verify endpoint, because A5.2 records what a
// verification reported rather than performing one. Real payer transport belongs to A9.
app.use('/api/encounters', encounterEligibilityVerificationRouter)
app.use('/api/eligibility-verifications', eligibilityVerificationRouter)

// A5.3 - the authorization case and its immutable lifecycle versions. Six routes, all GET or
// POST: no PATCH, no DELETE, and deliberately no request or submit endpoint, because A5.3
// records what an authorization source reported rather than performing one. A9 owns transport.
app.use('/api/encounters', encounterPriorAuthorizationRouter)
app.use('/api/prior-authorizations', priorAuthorizationRouter)
app.use('/api/prior-authorization-versions', priorAuthorizationVersionRouter)

// A5.4 - line-level authorization scope for one exact A5.3 version, captured once as an immutable
// batch, and a read-only scope evaluation against the Encounter as it stands now. No PATCH, no
// DELETE, no single-line append and no claim-line endpoint.
app.use('/api/prior-authorization-versions', versionAuthorizationLineRouter)
app.use('/api/authorization-lines', authorizationLineRouter)

// A5.5 - the pre-claim commercial context: which provider contract and which exact VERIFIED tariff
// schedule version apply to one Encounter, resolved read-only in one snapshot. One GET; nothing is
// persisted, priced or audited.
app.use('/api/encounters', encounterPreClaimCommercialContextRouter)

// A5.6 - the typed evidence-requirement payload of a documentation RuleVersion, Encounter evidence
// links, and the read-only completeness evaluation. No PATCH or DELETE anywhere, no upload or
// download, and no persisted result.
app.use('/api/rule-versions', ruleVersionEvidenceRequirementRouter)
app.use('/api/encounters', encounterEvidenceLinksRouter)
app.use('/api/encounters', encounterEvidenceCompletenessRouter)
app.use('/api/encounter-evidence-links', encounterEvidenceLinkRouter)

// A5.7 - read-only validation history. Runs are recorded by the internal recorder only; there is no
// create, execute, update or delete route.
app.use('/api/encounters', encounterValidationRunsRouter)
app.use('/api/validation-runs', validationRunRouter)
app.use('/api/validation-findings', validationFindingRouter)

// A5.8 - executing one deterministic pre-claim validation, recorded as a new immutable run. Admin only;
// no route accepts findings, outcomes or context from a client.
app.use('/api/encounters', encounterPreClaimValidationRouter)

// A5.9 - one immutable readiness assessment per validation run and policy (Admin only), assessment
// reads, and the read-only A6 handoff contract. No approve, submit, claim, update or delete route.
app.use('/api/validation-runs', validationRunReadinessRouter)
app.use('/api/encounters', encounterReadinessRouter)
app.use('/api/pre-claim-readiness-assessments', readinessAssessmentRouter)

// A6.1 - one stable A6-CLAIM-1 Claim per exact READY_FOR_REVIEW readiness assessment (Admin only), the
// Claim read and the Encounter's Claim history. No PATCH, PUT, DELETE, approve, submit or transmit route.
app.use('/api/pre-claim-readiness-assessments', assessmentClaimRouter)
app.use('/api/claims', claimRouter)
app.use('/api/encounters', encounterClaimRouter)

// A6.2 - the draft line and diagnosis structure of a Claim, built only from its bound handoff's exact
// sources: create, list, reorder, one-way remove and exact-set line diagnosis pointers. No DELETE, price,
// approve, submit or transmit route.
app.use('/api/claims', claimLinesRouter)
app.use('/api/claims', claimDiagnosesRouter)
app.use('/api/claim-lines', claimLineRouter)
app.use('/api/claim-diagnoses', claimDiagnosisRouter)

// A6.3 - governed tariff rates of an UNVERIFIED tariff version (create, list, retire) and immutable draft
// pricing runs of a Claim against its bound tariff version (create, list, read). No DELETE, edit, approve,
// submit or current-price route.
app.use('/api/tariff-schedule-versions', tariffVersionRatesRouter)
app.use('/api/tariff-rates', tariffRateRouter)
app.use('/api/claims', claimPricingRunsRouter)
app.use('/api/claim-pricing-runs', pricingRunRouter)

// A6.4 - the read-only draft preview of a Claim against an exact pricing run, immutable claim draft
// assessments (record, list, read) and nothing else. No approve, sign, submit, current-draft, PATCH or
// DELETE route.
app.use('/api/claims', claimDraftRouter)
app.use('/api/claim-draft-assessments', draftAssessmentRouter)

// A6.5 - immutable human review decisions on an exact A6.4 draft assessment (append, history, read) and
// the read-only derived review authority. No PATCH, PUT or DELETE, and no submit, payload or transport
// route.
app.use('/api/claims', claimReviewRouter)
app.use('/api/claim-review-decisions', reviewDecisionRouter)

// A6.6 - the read-only canonical payload preview of an exact Claim, draft assessment and approval. No
// create, update, delete, submit, send or payload-persistence route.
app.use('/api/claims', claimPayloadRouter)

// A6.7 - the immutable internal freeze (ClaimSubmission) of an approved, current canonical payload with its
// evidence package (freeze, history, metadata read, evidence manifest read). No PATCH, PUT or DELETE, and no
// send, retry, status or acknowledgement route.
app.use('/api/claims', claimSubmissionRouter)
app.use('/api/claim-submissions', frozenSubmissionRouter)

// A6.8 - internal lifecycle of a frozen submission: append one explicit event, read its history and its
// derived disposition. No status PATCH/PUT, no DELETE and no send, queue or acknowledgement route.
app.use('/api/claim-submissions', claimLifecycleRouter)

// A6.9 - immutable correction links between two freezes of one Claim (record, history, read). No DELETE,
// PATCH or PUT, and no resubmit, send, transport or payer-response route.
app.use('/api/claims', claimCorrectionRouter)
app.use('/api/claim-correction-links', correctionLinkRouter)

// A7.1 - immutable revenue source evidence for a frozen submission (register, history, read). No DELETE, PATCH
// or PUT, and no payment, posting, remittance, denial, adjudication or send route.
app.use('/api/claim-submissions', submissionRevenueEvidenceRouter)
app.use('/api/revenue-source-evidence', revenueEvidenceRouter)

// A7.2 - immutable, server-derived classifications of a revenue source evidence record (classify, history,
// read). No DELETE, PATCH or PUT, and no verify, payment, adjudication, denial, remittance or send route.
app.use('/api/revenue-source-evidence', sourceClassificationRouter)
app.use('/api/revenue-evidence-classifications', classificationRouter)

// A7.3 - immutable, server-derived internal adjudication readiness of a classification (record, history, read).
// No DELETE, PATCH or PUT, and no adjudication, payment, denial, remittance, verify, send or payer-response route.
app.use('/api/revenue-evidence-classifications', classificationReadinessRouter)
app.use('/api/adjudication-evidence-readiness', readinessRouter)

// A7.4 - immutable case snapshots of a frozen submission (assemble, history, read). No DELETE, PATCH or PUT, and
// no adjudication, payment, settlement, balance, remittance, send or payer-response route.
app.use('/api/claim-submissions', submissionCaseRouter)
app.use('/api/revenue-evidence-cases', caseRouter)

// A7.5 - immutable closure-prerequisite assessments of one exact case snapshot (assess, history, read). No DELETE,
// PATCH or PUT, and no adjudication, payment, posting, reconciliation, closure, balance or payer-response route.
app.use('/api/revenue-evidence-cases', caseAssessmentRouter)
app.use('/api/closure-prerequisite-assessments', prerequisiteAssessmentRouter)

// A7.6 - the read-only basis trace of one exact assessment (GET only). No write, no audit, no latest or per-Claim
// scan, and no adjudication, payment, posting, reconciliation, closure or payer-response route.
app.use('/api/closure-prerequisite-assessments', basisTraceRouter)

// A7.7 - the read-only revenue evidence timeline of one Claim (GET only). No write, no audit, no latest or current
// selector, no all-organization search, and no payment, remittance, balance, closure or payer-response route.
app.use('/api/claims', timelineRouter)

// A7.8 - the read-only revenue evidence delta of one Claim (GET only). No write, no audit, no latest or current
// selector, no all-organization search, and no payment, remittance, balance, closure or payer-response route.
app.use('/api/claims', deltaRouter)

// A7.9 - the read-only revenue evidence continuity of one Claim (GET only). No write, no audit, no latest or current
// selector, no all-organization search, and no payment, remittance, balance, closure or payer-response route.
app.use('/api/claims', continuityRouter)

// A1.8 — LAST
app.use('/api', apiNotFoundHandler)
app.use(apiErrorHandler)
