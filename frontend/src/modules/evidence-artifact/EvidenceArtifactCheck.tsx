import { useState, type FormEvent } from 'react'
import {
  appendEvidenceVersion,
  createEvidenceArtifact,
  listEvidenceArtifacts,
  listEvidenceVersions,
  type EvidenceArtifact,
  type EvidenceVersion,
} from './evidence-artifact.api.ts'

// A5.1 — minimal engineering check: create a synthetic artifact with version 1, list artifacts,
// load a version history, and append a version.
//
// It shows identifiers, version numbers and counts rather than the metadata itself. A storage
// reference, a content hash and a document type together describe what evidence was received and
// when, which is clinical and insurance workflow information; there is no reason for a development
// screen to display it by default. Nothing is logged or kept in browser storage, and this is not
// the final document-management experience.

const SYNTHETIC_HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

export default function EvidenceArtifactCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [documentType, setDocumentType] = useState('SYNTHETIC_ELIGIBILITY_RESPONSE')
  const [artifacts, setArtifacts] = useState<EvidenceArtifact[] | null>(null)
  const [artifactId, setArtifactId] = useState('')
  const [versions, setVersions] = useState<EvidenceVersion[] | null>(null)
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

  // Every value is generated here and is synthetic. The hash is a fixed canonical digest rather
  // than one computed from bytes, because A5.1 has no file transport and never sees content.
  const syntheticInput = (suffix: string) => ({
    storageRef: `synthetic://evidence/check/${suffix}`,
    contentHash: SYNTHETIC_HASH,
    documentType: documentType.trim(),
    sourceDate: null,
    receivedAt: new Date().toISOString(),
  })

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createEvidenceArtifact(organizationId.trim(), syntheticInput(`${Date.now()}-v1`))
      setArtifactId(created.id)
      setVersions(await listEvidenceVersions(created.id))
      setArtifacts(await listEvidenceArtifacts(organizationId.trim()))
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Evidence Artifact Check (A5.1)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. An evidence artifact is a stable identity; each version records one exact representation that was
        received and stored, and versions are append-only — a correction is a new version, never an edit. No file is uploaded or downloaded
        here: the storage reference is opaque and the bytes live elsewhere.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input className={inputClass} value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Organization UUID" aria-label="Organization UUID" />
        <input className={inputClass} value={documentType} onChange={(event) => setDocumentType(event.target.value)} placeholder="Document type (opaque label)" aria-label="Document type" />
        <button className={buttonClass} disabled={busy} type="submit">
          Create synthetic artifact + version 1
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setArtifacts(await listEvidenceArtifacts(organizationId.trim())))}>
          List artifacts
        </button>
        <input className={inputClass} value={artifactId} onChange={(event) => setArtifactId(event.target.value)} placeholder="Evidence artifact UUID" aria-label="Evidence artifact UUID" />
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setVersions(await listEvidenceVersions(artifactId.trim())))}>
          Load versions
        </button>
        <button
          className={buttonClass}
          disabled={busy}
          type="button"
          onClick={() =>
            void run(async () => {
              await appendEvidenceVersion(artifactId.trim(), syntheticInput(`${Date.now()}-next`))
              setVersions(await listEvidenceVersions(artifactId.trim()))
            })
          }
        >
          Append next version
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {artifacts && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{artifacts.length} artifact(s) in this organization:</p>
          <ul className="mt-1 list-disc pl-5">
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                {artifact.id} — latest version {artifact.latestVersion.version}
              </li>
            ))}
          </ul>
        </div>
      )}

      {versions && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {versions.length} version(s), append-only: <strong>{versions.map((version) => `v${version.version}`).join(' → ')}</strong>
          </p>
          <ul className="mt-1 grid gap-1">
            {versions.map((version) => (
              <li key={version.id}>
                v{version.version} — {version.id} — received {version.receivedAt}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
