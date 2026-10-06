import { useState, type FormEvent } from 'react'
import { listFindings, listRuns, type ValidationFindingSummary, type ValidationRunSummary } from './validation-run.api.ts'

// A5.7 — minimal read-only engineering check: list one Encounter's recorded validation runs and the
// findings of one run. There is deliberately no create or execute action: runs are recorded only by
// the internal recorder, which the integration harness exercises with synthetic drafts.
//
// Only the run time, validator version, finding count and each finding's sequence, layer, outcome
// and code are shown. No context id, message, field path, member value or provenance detail is
// displayed, nothing is logged, and nothing is kept in browser storage. No run is labelled current,
// and a PASS finding is not payer acceptance or claim readiness.

export default function ValidationRunCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [runs, setRuns] = useState<ValidationRunSummary[] | null>(null)
  const [findings, setFindings] = useState<ValidationFindingSummary[] | null>(null)
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
    void run(async () => {
      setFindings(null)
      setRuns((await listRuns(encounterId.trim())).items)
    })
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Validation Run Check (A5.7)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Read-only: validation runs are immutable history recorded by the internal recorder. No run is current, and a
        PASS finding is not payer acceptance or claim readiness.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List validation runs
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {runs && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{runs.length} recorded run(s), newest evaluation first</p>
          <ul className="mt-1 grid gap-1">
            {runs.map((item) => (
              <li key={item.id}>
                {item.evaluatedAt} — {item.validatorVersion} — {item.findingCount} finding(s){' '}
                <button className="underline disabled:opacity-50" disabled={busy} type="button" onClick={() => void run(async () => setFindings((await listFindings(item.id)).items))}>
                  show findings
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {findings && (
        <ol className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          {findings.map((item) => (
            <li key={item.id}>
              {item.sequence}. <strong>{item.outcome}</strong> {item.layer} — {item.findingCode}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
