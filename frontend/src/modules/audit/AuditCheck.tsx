import { useState, type FormEvent } from 'react'
import { loadAuditEvents, type AuditEvent } from './audit.api.ts'

export default function AuditCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [events, setEvents] = useState<AuditEvent[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    setEvents(null)

    try {
      setEvents(await loadAuditEvents(organizationId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'permission denied')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Audit Check</h2>
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
          disabled={loading}
          type="submit"
        >
          {loading ? 'Loading...' : 'Load Audit'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">permission denied</p>}

      {events && events.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No audit events yet.</p>
      )}

      {events && events.length > 0 && (
        <div className="mt-4 space-y-3">
          {events.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p className="text-slate-500">{item.occurredAt}</p>
              <p><strong>{item.actionCode}</strong></p>
              <p>Entity: {item.entityId}</p>
              <p>Actor: {item.actorUserId}</p>
              <p>Before: {item.beforeState ? JSON.stringify(item.beforeState) : '(none)'}</p>
              <p>After: {item.afterState ? JSON.stringify(item.afterState) : '(none)'}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
