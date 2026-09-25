import type { ComponentType } from 'react'
import OrganizationSetup from '../modules/organization/OrganizationSetup.tsx'
import FacilitySetup from '../modules/facility/FacilitySetup.tsx'
import AuthSetup from '../modules/auth/AuthSetup.tsx'
import AuthorizationCheck from '../modules/access/AuthorizationCheck.tsx'
import AuditCheck from '../modules/audit/AuditCheck.tsx'
import ClinicianCheck from '../modules/clinician/ClinicianCheck.tsx'
import SpecialtyCheck from '../modules/specialty/SpecialtyCheck.tsx'
import PayerCheck from '../modules/payer/PayerCheck.tsx'
import TpaCheck from '../modules/tpa/TpaCheck.tsx'
import NetworkCheck from '../modules/network/NetworkCheck.tsx'
import ServiceCheck from '../modules/service/ServiceCheck.tsx'
import ProcedureCodeCheck from '../modules/procedure-code/ProcedureCodeCheck.tsx'
import DiagnosisCodeCheck from '../modules/diagnosis-code/DiagnosisCodeCheck.tsx'
import ExternalIdentifierCheck from '../modules/external-identifier/ExternalIdentifierCheck.tsx'
import RuleSourceCheck from '../modules/rule-source/RuleSourceCheck.tsx'
import RuleSourceVersionCheck from '../modules/rule-source-version/RuleSourceVersionCheck.tsx'
import SourceInterpretationCheck from '../modules/source-interpretation/SourceInterpretationCheck.tsx'
import RuleSourceRelationshipCheck from '../modules/rule-source-relationship/RuleSourceRelationshipCheck.tsx'
import RuleDefinitionCheck from '../modules/rule-definition/RuleDefinitionCheck.tsx'
import RuleVersionCheck from '../modules/rule-version/RuleVersionCheck.tsx'
import RuleApplicabilityCheck from '../modules/rule-applicability/RuleApplicabilityCheck.tsx'
import RuleSourceBindingCheck from '../modules/rule-source-binding/RuleSourceBindingCheck.tsx'
import FacilityRegulatoryProfileCheck from '../modules/facility-regulatory/FacilityRegulatoryProfileCheck.tsx'
import CommercialCoverageCheck from '../modules/commercial-coverage/CommercialCoverageCheck.tsx'
import ReferenceDatasetCheck from '../modules/reference-dataset/ReferenceDatasetCheck.tsx'
import RuleSourceScopeCheck from '../modules/rule-source-scope/RuleSourceScopeCheck.tsx'
import RuleResolutionCheck from '../modules/rule-resolution/RuleResolutionCheck.tsx'
import RulePackCheck from '../modules/rule-pack/RulePackCheck.tsx'
import PatientCheck from '../modules/patient/PatientCheck.tsx'
import ClinicianAssignmentCheck from '../modules/clinician-assignment/ClinicianAssignmentCheck.tsx'
import InsuranceMembershipCheck from '../modules/insurance-membership/InsuranceMembershipCheck.tsx'
import EncounterCheck from '../modules/encounter/EncounterCheck.tsx'
import EncounterDiagnosisCheck from '../modules/encounter-diagnosis/EncounterDiagnosisCheck.tsx'

// FE-01 — every existing engineering check, moved unchanged from the former Development Check page.
// Keep order stable by architecture phase: A1 -> A2 -> A3 -> A4. A new backend *Check is registered
// here only; the check itself is never rewritten to fit the shell.

export type DeveloperCheck = {
  key: string
  label: string
  Component: ComponentType
}

export const developerChecks: DeveloperCheck[] = [
  { key: 'organization-setup', label: 'Organization setup', Component: OrganizationSetup },
  { key: 'facility-setup', label: 'Facility setup', Component: FacilitySetup },
  { key: 'auth-setup', label: 'Auth setup', Component: AuthSetup },
  { key: 'authorization', label: 'Authorization', Component: AuthorizationCheck },
  { key: 'audit', label: 'Audit', Component: AuditCheck },
  { key: 'clinician', label: 'Clinician', Component: ClinicianCheck },
  { key: 'specialty', label: 'Specialty', Component: SpecialtyCheck },
  { key: 'payer', label: 'Payer', Component: PayerCheck },
  { key: 'tpa', label: 'TPA', Component: TpaCheck },
  { key: 'network', label: 'Network', Component: NetworkCheck },
  { key: 'service', label: 'Service', Component: ServiceCheck },
  { key: 'procedure-code', label: 'Procedure code', Component: ProcedureCodeCheck },
  { key: 'diagnosis-code', label: 'Diagnosis code', Component: DiagnosisCodeCheck },
  { key: 'external-identifier', label: 'External identifier', Component: ExternalIdentifierCheck },
  { key: 'rule-source', label: 'Rule source', Component: RuleSourceCheck },
  { key: 'rule-source-version', label: 'Rule source version', Component: RuleSourceVersionCheck },
  { key: 'source-interpretation', label: 'Source interpretation', Component: SourceInterpretationCheck },
  { key: 'rule-source-relationship', label: 'Rule source relationship', Component: RuleSourceRelationshipCheck },
  { key: 'rule-definition', label: 'Rule definition', Component: RuleDefinitionCheck },
  { key: 'rule-version', label: 'Rule version', Component: RuleVersionCheck },
  { key: 'rule-applicability', label: 'Rule applicability', Component: RuleApplicabilityCheck },
  { key: 'rule-source-binding', label: 'Rule source binding', Component: RuleSourceBindingCheck },
  { key: 'facility-regulatory-profile', label: 'Facility regulatory profile', Component: FacilityRegulatoryProfileCheck },
  { key: 'commercial-coverage', label: 'Commercial coverage', Component: CommercialCoverageCheck },
  { key: 'reference-dataset', label: 'Reference dataset', Component: ReferenceDatasetCheck },
  { key: 'rule-source-scope', label: 'Rule source scope', Component: RuleSourceScopeCheck },
  { key: 'rule-resolution', label: 'Rule resolution', Component: RuleResolutionCheck },
  { key: 'rule-pack', label: 'Rule pack', Component: RulePackCheck },
  { key: 'patient', label: 'Patient', Component: PatientCheck },
  { key: 'clinician-assignment', label: 'Clinician assignment', Component: ClinicianAssignmentCheck },
  { key: 'insurance-membership', label: 'Insurance membership', Component: InsuranceMembershipCheck },
  { key: 'encounter', label: 'Encounter', Component: EncounterCheck },
  { key: 'encounter-diagnosis', label: 'Encounter diagnosis', Component: EncounterDiagnosisCheck },
]
