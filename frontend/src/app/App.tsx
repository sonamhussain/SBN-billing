import { useEffect, useState } from 'react'
import { getHealth } from '../shared/api'
import OrganizationSetup from '../modules/organization/OrganizationSetup.tsx'
import FacilitySetup from '../modules/facility/FacilitySetup.tsx'
import AuthSetup from '../modules/auth/AuthSetup.tsx'
import AuthorizationCheck from '../modules/access/AuthorizationCheck.tsx'
import AuditCheck from '../modules/audit/AuditCheck.tsx'

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
      </div>
    </main>
  )
}
