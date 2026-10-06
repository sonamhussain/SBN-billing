import { useState, type FormEvent } from 'react'
import { loadBillingContext, type BillingContextSummary } from './encounter-billing-context.api.ts'

// A4.9 — minimal engineering check: load one canonical billing context and summarize it.
//
// It deliberately shows counts and identifiers rather than the bundle itself. A raw JSON dump would
// put patient identity, the selected membership and every clinical fact of an encounter on screen
// at once, which is exactly the disclosure the dedicated aggregate permission exists to control.
// Nothing here is logged or persisted in the browser. FE-05 later owns the real Pre-Claim
// experience; this is only enough to prove the contract responds.

export default function EncounterBillingContextCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [context, setContext] = useState<BillingContextSummary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  function handleLoad(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    void (async () => {
      try {
        setContext(await loadBillingContext(encounterId.trim()))
      } catch (err) {
        setContext(null)
        setError(err instanceof Error ? err.message : 'Request failed')
      } finally {
        setBusy(false)
      }
    })()
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const profile = context?.providerContext.facilityRegulatoryProfile

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Encounter Billing Context Check (A4.9)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. One read-only bundle assembled from a single database snapshot: the encounter, its patient, the
        selected membership, the exact provider and regulatory rows it was written against, and its active diagnoses, activities,
        observations and outside-system mappings. It decides nothing — no eligibility, no authorization, no readiness, no claim.
      </p>

      <form className="mt-4 flex flex-wrap gap-2" onSubmit={handleLoad}>
        <input
          className={inputClass}
          value={encounterId}
          onChange={(event) => setEncounterId(event.target.value)}
          placeholder="Encounter UUID"
          aria-label="Encounter UUID"
        />
        <button className={buttonClass} disabled={busy} type="submit">
          Load Billing Context
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {context && (
        <div className="mt-3 grid gap-1 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Schema: <strong>{context.schemaVersion}</strong> — assembled at {context.assembledAt}
          </p>
          <p>
            Patient: {context.patient.displayName} | DOB {context.patient.dateOfBirth}
          </p>
          <p>
            Facility: {context.facility.name} — Clinician: {context.clinician.displayName} — Service date {context.encounter.serviceDate}
          </p>
          <p>Coverage: {context.insuranceMembership ? `membership ${context.insuranceMembership.id}` : 'none selected'}</p>
          <p>Provider context:</p>
          <p className="pl-4">Assignment: {context.providerContext.clinicianFacilityAssignment.id}</p>
          <p className="pl-4">
            Regulatory profile: {profile?.id} | {profile?.jurisdictionCode} | {profile?.regulatoryAuthorityCode} | status {profile?.status}
          </p>
          <p>
            Diagnoses: {context.diagnoses.length} — Activities: {context.activities.length} — Observations: {context.observations.length}
          </p>
          <p>External IDs:</p>
          <p className="pl-4">Patient: {context.externalIdentifiers.patient.length}</p>
          <p className="pl-4">Encounter: {context.externalIdentifiers.encounter.length}</p>
        </div>
      )}
    </section>
  )
}
