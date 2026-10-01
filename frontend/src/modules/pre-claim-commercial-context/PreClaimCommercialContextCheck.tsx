import { useState, type FormEvent } from 'react'
import { ResolutionRefused, resolveCommercialContext, type PreClaimCommercialContext } from './pre-claim-commercial-context.api.ts'

// A5.5 — minimal engineering check: resolve the pre-claim commercial context for one synthetic
// Encounter and show the resolved IDs, or the reason resolution refused.
//
// Only synthetic IDs and the resolution reason are shown. No member or policy value, contract
// document, rate or price exists here, nothing is logged, and nothing is kept in browser storage.
// This is not a pricing or claim screen.

export default function PreClaimCommercialContextCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [context, setContext] = useState<PreClaimCommercialContext | null>(null)
  const [refusal, setRefusal] = useState<{ reason: string; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  function handleResolve(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setContext(null)
    setRefusal(null)
    resolveCommercialContext(encounterId.trim())
      .then(setContext)
      .catch((err) =>
        setRefusal({
          reason: err instanceof ResolutionRefused && err.reason ? err.reason : 'REQUEST_FAILED',
          message: err instanceof Error ? err.message : 'Request failed',
        }),
      )
      .finally(() => setBusy(false))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Pre-Claim Commercial Context Check (A5.5)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Resolves exactly one provider contract and one VERIFIED tariff schedule version for an Encounter, read-only. Two
        candidates are <strong>ambiguous</strong>, never a guessed winner, and nothing here is a price.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleResolve}>
        <input className={inputClass} value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Resolve commercial context
        </button>
      </form>

      {refusal && (
        <p className="mt-3 text-sm text-red-700">
          <strong>{refusal.reason}</strong> — {refusal.message}
        </p>
      )}

      {context && (
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <dt>Service date</dt>
          <dd>{context.serviceDate}</dd>
          <dt>Provider contract</dt>
          <dd className="font-mono">{context.providerContractId}</dd>
          <dt>Tariff schedule</dt>
          <dd className="font-mono">{context.tariffScheduleId}</dd>
          <dt>Tariff version</dt>
          <dd className="font-mono">{context.tariffScheduleVersionId}</dd>
        </dl>
      )}
    </section>
  )
}
