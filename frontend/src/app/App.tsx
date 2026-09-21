import { useEffect, useState } from 'react'
import { getHealth } from '../shared/api'
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

type ApiStatus = 'checking' | 'online' | 'offline'

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')

  useEffect(() => {
    getHealth()
      .then(() => setApiStatus('online'))
      .catch(() => setApiStatus('offline'))
  }, [])

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-2xl rounded-xl bg-white p-6 shadow-sm">
        <p className="text-sm font-medium text-slate-500">SBN Billing</p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Development Check
        </h1>
        <p className="mt-4 text-slate-700">
          API Status: <strong>{apiStatus.toUpperCase()}</strong>
        </p>

        {apiStatus === 'online' && <OrganizationSetup />}
        {apiStatus === 'online' && <FacilitySetup />}
        {apiStatus === 'online' && <AuthSetup />}
        {apiStatus === 'online' && <AuthorizationCheck />}
        {apiStatus === 'online' && <AuditCheck />}
        {apiStatus === 'online' && <ClinicianCheck />}
        {apiStatus === 'online' && <SpecialtyCheck />}
        {apiStatus === 'online' && <PayerCheck />}
        {apiStatus === 'online' && <TpaCheck />}
        {apiStatus === 'online' && <NetworkCheck />}
        {apiStatus === 'online' && <ServiceCheck />}
        {apiStatus === 'online' && <ProcedureCodeCheck />}
        {apiStatus === 'online' && <DiagnosisCodeCheck />}
        {apiStatus === 'online' && <ExternalIdentifierCheck />}
        {apiStatus === 'online' && <RuleSourceCheck />}
        {apiStatus === 'online' && <RuleSourceVersionCheck />}
        {apiStatus === 'online' && <SourceInterpretationCheck />}
        {apiStatus === 'online' && <RuleSourceRelationshipCheck />}
        {apiStatus === 'online' && <RuleDefinitionCheck />}
        {apiStatus === 'online' && <RuleVersionCheck />}
        {apiStatus === 'online' && <RuleApplicabilityCheck />}
        {apiStatus === 'online' && <RuleSourceBindingCheck />}
        {apiStatus === 'online' && <FacilityRegulatoryProfileCheck />}
        {apiStatus === 'online' && <CommercialCoverageCheck />}
        {apiStatus === 'online' && <ReferenceDatasetCheck />}
        {apiStatus === 'online' && <RuleSourceScopeCheck />}
        {apiStatus === 'online' && <RuleResolutionCheck />}
        {apiStatus === 'online' && <RulePackCheck />}
        {apiStatus === 'online' && <PatientCheck />}
      </div>
    </main>
  )
}
