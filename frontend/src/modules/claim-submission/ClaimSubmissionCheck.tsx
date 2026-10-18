import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.7 — minimal read-only engineering check for frozen claim submissions: list the freezes of one Claim,
// read one frozen submission's metadata and (Admin) its typed evidence manifest. Synthetic development data
// only. The page never freezes, sends or changes anything: there is no freeze, submit or send action, raw
// bytes are never requested, and nothing is logged or kept in browser storage. A frozen record is an
// internal custody record, not evidence of delivery or payment.

type Submission = {
  submissionId: string
  claimId: string
  draftAssessmentId: string
  approvalDecisionId: string
  pricingRunId: string
  submissionContractVersion: string
  payloadSchemaVersion: string
  payloadSha256: string
  payloadByteLength: number
  frozenAt: string
  evidencePackage: { evidencePackageId: string; manifestContractVersion: string; entryCount: number; manifestSha256: string; packageSealSha256: string }
}

type Manifest = {
  submissionId: string
  manifestSha256: string
  packageSealSha256: string
  manifest: { entries: { ordinal: number; referenceKind: string; referenceId: string; referenceVersionId: string | null; contentHash: string | null; evidenceRole: string }[] }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path)
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return (await response.json()) as T
}

export default function ClaimSubmissionCheck() {
  const [claimId, setClaimId] = useState('')
  const [submissionId, setSubmissionId] = useState('')
  const [items, setItems] = useState<Submission[] | null>(null)
  const [submission, setSubmission] = useState<Submission | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setNotice('')
    try {
      await action()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    setItems(null)
    void run(async () => setItems((await getJson<{ items: Submission[] }>(`/api/claims/${claimId.trim()}/submissions`)).items))
  }

  function handleRead(event: FormEvent) {
    event.preventDefault()
    setSubmission(null)
    setManifest(null)
    void run(async () => setSubmission(await getJson<Submission>(`/api/claim-submissions/${submissionId.trim()}`)))
  }

  function handleManifest() {
    setManifest(null)
    void run(async () => setManifest(await getJson<Manifest>(`/api/claim-submissions/${submissionId.trim()}/evidence-manifest`)))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Frozen Claim Submission Check (A6.7)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. A frozen submission is an internal, immutable custody record of approved bytes; it has not been sent and is not
        proof of delivery or payment.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List frozen submissions (read only)
        </button>
      </form>

      {items && (
        <ul className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {items.length === 0 && <li>No frozen submission for this Claim.</li>}
          {items.map((item) => (
            <li key={item.submissionId} className="break-all">
              {item.frozenAt} — {item.submissionId} — approval {item.approvalDecisionId} — {item.evidencePackage.entryCount} evidence reference(s)
            </li>
          ))}
        </ul>
      )}

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className={inputClass} value={submissionId} onChange={(event) => setSubmissionId(event.target.value)} placeholder="Submission UUID" aria-label="Submission UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Read frozen submission (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {submission && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {submission.submissionContractVersion} / {submission.payloadSchemaVersion} — {submission.payloadByteLength} bytes — frozen {submission.frozenAt}
          </p>
          <p className="break-all">Claim {submission.claimId} — draft assessment {submission.draftAssessmentId} — approval {submission.approvalDecisionId}</p>
          <p className="break-all">Payload SHA-256 {submission.payloadSha256}</p>
          <p className="break-all">
            {submission.evidencePackage.manifestContractVersion} — {submission.evidencePackage.entryCount} reference(s) — manifest SHA-256 {submission.evidencePackage.manifestSha256}
          </p>
          <p className="break-all">Package seal {submission.evidencePackage.packageSealSha256}</p>
          <button className={`${buttonClass} mt-2`} disabled={busy} type="button" onClick={handleManifest}>
            Show evidence manifest (Admin, read only)
          </button>
        </div>
      )}

      {manifest && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-xs text-slate-800">
          {manifest.manifest.entries.map((entry) => (
            <li key={entry.ordinal} className="break-all">
              #{entry.ordinal} {entry.referenceKind} ({entry.evidenceRole}) {entry.referenceId}
              {entry.referenceVersionId ? ` version ${entry.referenceVersionId}` : ''}
              {entry.contentHash ? ` sha256 ${entry.contentHash}` : ''}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
