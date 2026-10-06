import { useState, type FormEvent } from 'react'
import { EvaluationRefused, evaluateCompleteness, linkEvidence, type EvidenceCompletenessEvaluation } from './evidence-completeness.api.ts'

// A5.6 — minimal engineering check: link one synthetic evidence version to an Encounter, and evaluate
// evidence completeness for the Encounter or one of its active activities or diagnoses.
//
// Only synthetic requirement and rule-version ids and summary counts are shown. No document type,
// evidence id, source date, member value or rule-source detail is displayed, nothing is logged, and
// nothing is kept in browser storage. A SATISFIED row is a completeness fact, not a validation
// outcome and not claim readiness.

const orNull = (value: string) => (value.trim() === '' ? null : value.trim())

export default function EvidenceCompletenessCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [evidenceVersionId, setEvidenceVersionId] = useState('')
  const [activityId, setActivityId] = useState('')
  const [diagnosisId, setDiagnosisId] = useState('')
  const [evaluation, setEvaluation] = useState<EvidenceCompletenessEvaluation | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setNotice('')
    try {
      await action()
    } catch (err) {
      setNotice(err instanceof EvaluationRefused && err.reason ? `${err.reason} — ${err.message}` : err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleEvaluate(event: FormEvent) {
    event.preventDefault()
    void run(async () => setEvaluation(await evaluateCompleteness(encounterId.trim(), { encounterActivityId: orNull(activityId), encounterDiagnosisId: orNull(diagnosisId) })))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Evidence Completeness Check (A5.6)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Requirements come from governed A3 rule versions; evidence is matched by exact version. Completeness is computed
        read-only and is not a validation outcome or claim readiness.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleEvaluate}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <div className="flex flex-wrap gap-2">
          <input className={`${inputClass} flex-1`} value={evidenceVersionId} onChange={(event) => setEvidenceVersionId(event.target.value)} placeholder="Evidence version UUID (A5.1)" aria-label="Evidence version UUID" />
          <button
            className={buttonClass}
            disabled={busy}
            type="button"
            onClick={() =>
              void run(async () => {
                await linkEvidence(encounterId.trim(), evidenceVersionId.trim())
                setNotice('Evidence version linked.')
              })
            }
          >
            Link evidence
          </button>
        </div>
        <input className={inputClass} value={activityId} onChange={(event) => setActivityId(event.target.value)} placeholder="Encounter activity UUID (optional)" aria-label="Encounter activity UUID" />
        <input className={inputClass} value={diagnosisId} onChange={(event) => setDiagnosisId(event.target.value)} placeholder="Encounter diagnosis UUID (optional)" aria-label="Encounter diagnosis UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Evaluate completeness
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {evaluation && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            {evaluation.requirements.length} applicable requirement(s) on {evaluation.businessDate}
          </p>
          <ul className="mt-1 grid gap-1">
            {evaluation.requirements.map((requirement) => (
              <li key={requirement.evidenceRequirementId}>
                <strong>{requirement.state}</strong> — valid {requirement.validCount} of {requirement.minimumCount} needed; invalid {requirement.invalidCount}, stale{' '}
                {requirement.staleCount}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
