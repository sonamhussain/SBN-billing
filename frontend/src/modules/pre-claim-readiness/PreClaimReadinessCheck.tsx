import { useState, type FormEvent } from 'react'
import { listAssessments, readHandoffCounts, recordAssessment, type HandoffCounts, type ReadinessAssessmentSummary } from './pre-claim-readiness.api.ts'

// A5.9 — minimal engineering check: record a readiness assessment for one exact validation run, list
// an Encounter's assessments, and check whether one can be handed off to A6. Only the assessment id,
// state, policy version, validation run id and finding counts are shown. No finding code, message,
// context id, member value or reference id is displayed, nothing is logged, and nothing is kept in
// browser storage. READY_FOR_REVIEW is not submission approval, payer acceptance or a claim status.

export default function PreClaimReadinessCheck() {
  const [validationRunId, setValidationRunId] = useState('')
  const [encounterId, setEncounterId] = useState('')
  const [recorded, setRecorded] = useState<ReadinessAssessmentSummary | null>(null)
  const [assessments, setAssessments] = useState<ReadinessAssessmentSummary[] | null>(null)
  const [handoff, setHandoff] = useState<{ assessmentId: string; counts: HandoffCounts } | null>(null)
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

  function handleRecord(event: FormEvent) {
    event.preventDefault()
    void run(async () => setRecorded(await recordAssessment(validationRunId.trim())))
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      setHandoff(null)
      setAssessments((await listAssessments(encounterId.trim())).items)
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Pre-Claim Readiness Check (A5.9)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. An assessment is immutable and belongs to one exact validation run. READY_FOR_REVIEW only lets human claim
        review begin; it is not submission approval or payer acceptance.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRecord}>
        <input className={inputClass} value={validationRunId} onChange={(event) => setValidationRunId(event.target.value)} placeholder="Validation run UUID" aria-label="Validation run UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Record readiness assessment
        </button>
      </form>

      {recorded && (
        <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          Assessment {recorded.id} — <strong>{recorded.state}</strong> — {recorded.readinessPolicyVersion} — run {recorded.validationRunId}
        </p>
      )}

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List readiness assessments
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {assessments && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{assessments.length} assessment(s), newest first</p>
          <ul className="mt-1 grid gap-1">
            {assessments.map((item) => (
              <li key={item.id}>
                {item.id} — <strong>{item.state}</strong> — {item.readinessPolicyVersion} — run {item.validationRunId}{' '}
                <button
                  className="underline disabled:opacity-50"
                  disabled={busy}
                  type="button"
                  onClick={() => void run(async () => setHandoff({ assessmentId: item.id, counts: await readHandoffCounts(item.id) }))}
                >
                  check A6 handoff
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {handoff && (
        <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          Handoff available for {handoff.assessmentId}: {handoff.counts.total} finding(s) — {handoff.counts.pass} pass, {handoff.counts.warning} warning,{' '}
          {handoff.counts.restrict} restrict, {handoff.counts.fail} fail
        </p>
      )}
    </section>
  )
}
