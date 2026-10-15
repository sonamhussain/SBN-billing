import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.4 — minimal engineering check for claim draft integrity: preview a Claim's draft against an exact
// pricing run, record an immutable assessment, list a Claim's assessments and read one. Synthetic
// development data only. Only ids, outcomes, finding codes and the fingerprint are shown — no patient,
// member, payer, diagnosis text or clinical value. REVIEWABLE means "candidate for human review"; it is not
// approval, sign-off or submission. Nothing is logged or kept in browser storage, and no product claim
// screen is built here (FE-04 owns that later). The pricing run is always typed by the user: nothing here
// picks a "latest" run.

type Finding = {
  ordinal: number
  findingCode: string
  severity: string
  ownerScope: string
  relatedClaimLineId: string | null
  relatedClaimDiagnosisId: string | null
}

type Draft = {
  outcome: string
  assemblyFingerprint: string
  handoffRefusal: string | null
  lines: { claimLineId: string; sequence: number }[]
  diagnoses: { claimDiagnosisId: string; sequence: number; roleCode: string }[]
  pricing: { pricingRunId: string; overallResult: string; currencyCode: string | null; totalExtendedTariffAmount: string | null } | null
  findings: Finding[]
  evaluatedAt: string
}

type Assessment = {
  id: string
  pricingRunId: string
  outcome: string
  assemblyFingerprint: string
  findingCount: number
  evaluatedAt: string
  findings?: Finding[]
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

function FindingList({ findings }: { findings: Finding[] }) {
  return (
    <ul className="mt-1 grid gap-1">
      {findings.map((finding) => (
        <li key={finding.ordinal}>
          {finding.ordinal}. {finding.findingCode} — {finding.severity} — {finding.ownerScope}
          {finding.relatedClaimLineId ? ` — line ${finding.relatedClaimLineId}` : ''}
          {finding.relatedClaimDiagnosisId ? ` — diagnosis ${finding.relatedClaimDiagnosisId}` : ''}
        </li>
      ))}
    </ul>
  )
}

export default function ClaimDraftCheck() {
  const [claimId, setClaimId] = useState('')
  const [pricingRunId, setPricingRunId] = useState('')
  const [assessmentId, setAssessmentId] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [assessments, setAssessments] = useState<Assessment[] | null>(null)
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

  // The pricing run id is an opaque synthetic UUID, never personal data.
  const draftPath = () => {
    const runId = pricingRunId.trim()
    return `/api/claims/${claimId.trim()}/draft${runId === '' ? '' : `?pricingRunId=${encodeURIComponent(runId)}`}`
  }

  function handlePreview(event: FormEvent) {
    event.preventDefault()
    void run(async () => setDraft(await handle<Draft>(await fetch(draftPath()))))
  }

  function handleAssess(event: FormEvent) {
    event.preventDefault()
    void run(async () =>
      setAssessment(
        await handle<Assessment>(
          await fetch(`/api/claims/${claimId.trim()}/draft-assessments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pricingRunId: pricingRunId.trim() }),
          }),
        ),
      ),
    )
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    void run(async () => setAssessments((await handle<{ items: Assessment[] }>(await fetch(`/api/claims/${claimId.trim()}/draft-assessments`))).items))
  }

  function handleRead(event: FormEvent) {
    event.preventDefault()
    void run(async () => setAssessment(await handle<Assessment>(await fetch(`/api/claim-draft-assessments/${assessmentId.trim()}`))))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Draft Integrity Check (A6.4)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. REVIEWABLE means the draft is a candidate for human review; it confers no approval or submission. Structural checks
        only — no regulator or payer coding compliance is established here.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handlePreview}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <input
          className={inputClass}
          value={pricingRunId}
          onChange={(event) => setPricingRunId(event.target.value)}
          placeholder="Exact pricing run UUID (never chosen automatically)"
          aria-label="Pricing run UUID"
        />
        <button className={buttonClass} disabled={busy} type="submit">
          Preview draft (read only)
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleAssess}>
        <button className={buttonClass} disabled={busy} type="submit">
          Record assessment for the claim and pricing run above
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <button className={buttonClass} disabled={busy} type="submit">
          List assessments of the claim above
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className={inputClass} value={assessmentId} onChange={(event) => setAssessmentId(event.target.value)} placeholder="Assessment UUID" aria-label="Assessment UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Read assessment
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {draft && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Preview — {draft.outcome} — {draft.lines.length} line(s), {draft.diagnoses.length} diagnosis(es) —{' '}
            {draft.pricing === null ? 'no pricing run' : `run ${draft.pricing.pricingRunId} ${draft.pricing.overallResult}`}
            {draft.handoffRefusal ? ` — handoff refused: ${draft.handoffRefusal}` : ''}
          </p>
          <p className="break-all">Fingerprint {draft.assemblyFingerprint}</p>
          <FindingList findings={draft.findings} />
        </div>
      )}

      {assessment && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Assessment {assessment.id} — {assessment.outcome} — run {assessment.pricingRunId} — {assessment.findingCount} finding(s)
          </p>
          <p className="break-all">Fingerprint {assessment.assemblyFingerprint}</p>
          <FindingList findings={assessment.findings ?? []} />
        </div>
      )}

      {assessments && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{assessments.length} assessment(s), newest first (history order, never a current or approved draft)</p>
          <ul className="mt-1 grid gap-1">
            {assessments.map((item) => (
              <li key={item.id}>
                {item.id} — {item.outcome} — run {item.pricingRunId} — {item.findingCount} finding(s)
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
