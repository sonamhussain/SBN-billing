import { useState, type FormEvent } from 'react'
import {
  appendVersion,
  createPriorAuthorization,
  listVersions,
  type AuthorizationStatus,
  type PriorAuthorizationVersion,
  type VersionKind,
} from './prior-authorization.api.ts'

// A5.3 — minimal engineering check: record a synthetic authorization case with its INITIAL version,
// append later lifecycle versions, and read the history.
//
// It shows the case UUID, the version number and the reported status, and nothing else. The
// authorization reference, the evidence links, the eligibility link and the commercial and provider
// identities together describe a patient's insurance situation, so a development screen has no
// reason to display them. Nothing is logged or kept in browser storage, and this is not the
// authorization workflow UI.

const KINDS: VersionKind[] = ['RESPONSE', 'AMENDMENT', 'EXTENSION', 'CORRECTION']
const STATUSES: AuthorizationStatus[] = ['REQUESTED', 'PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'DENIED', 'UNKNOWN']

export default function PriorAuthorizationCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [requestEvidenceId, setRequestEvidenceId] = useState('')
  const [responseEvidenceId, setResponseEvidenceId] = useState('')
  const [authorizationId, setAuthorizationId] = useState('')
  const [kind, setKind] = useState<VersionKind>('RESPONSE')
  const [status, setStatus] = useState<AuthorizationStatus>('APPROVED')
  const [versions, setVersions] = useState<PriorAuthorizationVersion[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createPriorAuthorization(encounterId.trim(), {
        versionKind: 'INITIAL',
        status: 'REQUESTED',
        authorizationReference: null,
        eligibilityVerificationId: null,
        requestedAt: new Date().toISOString(),
        respondedAt: null,
        validFrom: null,
        validThrough: null,
        evidenceLinks: [{ role: 'REQUEST', evidenceArtifactVersionId: requestEvidenceId.trim() }],
      })
      setAuthorizationId(created.id)
      setVersions(await listVersions(created.id))
    })
  }

  // A decided status must say when it was decided and be backed by the response that carries it, so
  // the check sends both together rather than letting the server refuse an incomplete snapshot.
  function handleAppend() {
    void run(async () => {
      const respondedAt = new Date().toISOString()
      await appendVersion(authorizationId.trim(), {
        versionKind: kind,
        status,
        authorizationReference: null,
        eligibilityVerificationId: null,
        requestedAt: null,
        respondedAt,
        validFrom: null,
        validThrough: null,
        evidenceLinks: [{ role: 'RESPONSE', evidenceArtifactVersionId: responseEvidenceId.trim() }],
      })
      setVersions(await listVersions(authorizationId.trim()))
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Prior Authorization Check (A5.3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. An authorization case freezes one exact Encounter context; every request, response, amendment, extension and
        correction is a new immutable version, never an edit. A <strong>PARTIALLY_APPROVED</strong> header does not say which activity is approved —
        that belongs to A5.4.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <input className={inputClass} value={requestEvidenceId} onChange={(event) => setRequestEvidenceId(event.target.value)} placeholder="REQUEST evidence version UUID (A5.1)" aria-label="Request evidence version UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Record synthetic case + INITIAL version
        </button>
      </form>

      <div className="mt-3 grid gap-2">
        <input className={inputClass} value={authorizationId} onChange={(event) => setAuthorizationId(event.target.value)} placeholder="Prior authorization UUID" aria-label="Prior authorization UUID" />
        <input className={inputClass} value={responseEvidenceId} onChange={(event) => setResponseEvidenceId(event.target.value)} placeholder="RESPONSE evidence version UUID (A5.1)" aria-label="Response evidence version UUID" />
        <select className={inputClass} value={kind} onChange={(event) => setKind(event.target.value as VersionKind)} aria-label="Version kind">
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as AuthorizationStatus)} aria-label="Reported status">
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <button className={buttonClass} disabled={busy} type="button" onClick={handleAppend}>
            Append version
          </button>
          <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setVersions(await listVersions(authorizationId.trim())))}>
            Load version history
          </button>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {versions && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {versions.length} version(s), append-only: <strong>{versions.map((version) => `v${version.version}`).join(' → ')}</strong>
          </p>
          <ul className="mt-1 grid gap-1">
            {versions.map((version) => (
              <li key={version.id}>
                v{version.version} — {version.versionKind} — reported <strong>{version.status}</strong>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-600">
            The last row is the latest <em>recorded</em> version. It is not necessarily the usable one — deciding that belongs to A5.4 and A5.8.
          </p>
        </div>
      )}
    </section>
  )
}
