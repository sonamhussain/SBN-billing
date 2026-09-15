import { useState, type FormEvent } from 'react'
import {
  activateFacilityRegulatoryProfile,
  createFacilityRegulatoryProfile,
  loadFacilityRegulatoryProfiles,
  type FacilityRegulatoryProfile,
} from './facility-regulatory.api.ts'

export default function FacilityRegulatoryProfileCheck() {
  const [facilityId, setFacilityId] = useState('')
  const [jurisdictionCode, setJurisdictionCode] = useState('AE-DU')
  const [regulatoryAuthorityCode, setRegulatoryAuthorityCode] = useState('DHA')
  const [effectiveFrom, setEffectiveFrom] = useState('2026-01-01')
  const [effectiveTo, setEffectiveTo] = useState('')
  const [activateId, setActivateId] = useState('')
  const [profiles, setProfiles] = useState<FacilityRegulatoryProfile[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activating, setActivating] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createFacilityRegulatoryProfile(facilityId, jurisdictionCode, regulatoryAuthorityCode, effectiveFrom, effectiveTo)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleLoad() {
    setLoading(true)
    setError('')
    try {
      setProfiles(await loadFacilityRegulatoryProfiles(facilityId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleActivate(event: FormEvent) {
    event.preventDefault()
    setActivating(true)
    setError('')
    try {
      await activateFacilityRegulatoryProfile(activateId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setActivating(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Facility Regulatory Profile Check (REF-01 / R1)</h2>
      <p className="mt-1 text-sm text-slate-600">Synthetic development data only. No overlapping ACTIVE ranges per facility.</p>

      <input
        className="mt-4 w-full rounded-md border border-slate-300 px-3 py-2"
        value={facilityId}
        onChange={(event) => setFacilityId(event.target.value)}
        placeholder="Facility UUID"
        aria-label="Facility UUID"
      />

      <form className="mt-3 grid gap-2" onSubmit={handleCreate}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={jurisdictionCode} onChange={(e) => setJurisdictionCode(e.target.value)} placeholder="jurisdictionCode" aria-label="Jurisdiction code" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={regulatoryAuthorityCode} onChange={(e) => setRegulatoryAuthorityCode(e.target.value)} placeholder="regulatoryAuthorityCode" aria-label="Regulatory authority code" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} placeholder="effectiveFrom (YYYY-MM-DD)" aria-label="Effective from" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} placeholder="effectiveTo (optional)" aria-label="Effective to" />
        <div className="flex gap-2">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={saving} type="submit">
            {saving ? 'Saving...' : 'Create Profile'}
          </button>
          <button className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50" disabled={loading} type="button" onClick={handleLoad}>
            {loading ? 'Loading...' : 'Load Profiles'}
          </button>
        </div>
      </form>

      <form className="mt-4 flex gap-2" onSubmit={handleActivate}>
        <input className="flex-1 rounded-md border border-slate-300 px-3 py-2" value={activateId} onChange={(e) => setActivateId(e.target.value)} placeholder="Profile UUID to activate" aria-label="Activate profile id" />
        <button className="rounded-md bg-slate-600 px-4 py-2 text-white disabled:opacity-50" disabled={activating} type="submit">
          {activating ? 'Activating...' : 'Activate'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {profiles && profiles.length === 0 && <p className="mt-3 text-sm text-slate-600">No regulatory profiles yet.</p>}

      {profiles && profiles.length > 0 && (
        <div className="mt-4 space-y-2">
          {profiles.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                {item.status} — {item.jurisdictionCode}/{item.regulatoryAuthorityCode} — {item.effectiveFrom} to {item.effectiveTo ?? 'open'} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
