import { useState, type FormEvent } from 'react'
import { checkAccess, type AccessCheckResult } from './access.api.ts'

export default function AuthorizationCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [result, setResult] = useState<AccessCheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setChecking(true)
    setResult(await checkAccess(organizationId))
    setChecking(false)
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Authorization Check</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only.</p>

      <form className="mt-4 flex gap-2" onSubmit={handleSubmit}>
        <input
          className="flex-1 rounded-md border border-slate-300 px-3 py-2"
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
          aria-label="Organization ID"
          placeholder="Organization ID"
        />
        <button
          className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
          disabled={checking}
          type="submit"
        >
          {checking ? 'Checking...' : 'Check Access'}
        </button>
      </form>

      {result?.status === 'allowed' && (
        <div className="mt-4 rounded-md bg-slate-100 p-3 text-sm">
          <p><strong>Membership ID:</strong> {result.proof.membershipId}</p>
          <p><strong>Permissions:</strong> {result.proof.permissions.join(', ') || '(none)'}</p>
        </div>
      )}
      {result?.status === 'unauthenticated' && (
        <p className="mt-3 text-sm text-red-700">Sign in required</p>
      )}
      {result?.status === 'forbidden' && (
        <p className="mt-3 text-sm text-red-700">No access to this Organization</p>
      )}
      {result?.status === 'error' && (
        <p className="mt-3 text-sm text-red-700">{result.message}</p>
      )}
    </section>
  )
}
