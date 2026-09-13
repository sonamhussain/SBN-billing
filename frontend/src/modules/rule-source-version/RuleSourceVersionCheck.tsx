import { useState, type FormEvent } from 'react'
import {
  activateRuleSourceVersion,
  createRuleSourceVersion,
  evaluateActivation,
  loadRuleSourceVersions,
  publishRuleSourceVersion,
  resumeRuleSourceVersion,
  retireRuleSourceVersion,
  suspendRuleSourceVersion,
  updateLifecycleMetadata,
  updateSourceVerification,
  type RuleSourceVersion,
} from './rule-source-version.api.ts'

export default function RuleSourceVersionCheck() {
  const [sourceId, setSourceId] = useState('')
  const [version, setVersion] = useState('2026.1')
  const [rawEvidenceRef, setRawEvidenceRef] = useState('synthetic-evidence://rule-source/demo/2026.1')
  const [versions, setVersions] = useState<RuleSourceVersion[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [publicationDate, setPublicationDate] = useState('2026-09-01')
  const [effectiveFrom, setEffectiveFrom] = useState('2026-10-01')
  const [effectiveTo, setEffectiveTo] = useState('')
  const [businessDate, setBusinessDate] = useState('2026-10-15')
  const [jurisdictionCode, setJurisdictionCode] = useState('AE-DU')
  const [previewBlockers, setPreviewBlockers] = useState<Record<string, string[]>>({})

  async function refresh() {
    setVersions(await loadRuleSourceVersions(sourceId))
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleSourceVersion(sourceId, version, rawEvidenceRef)
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
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  async function withBusy(id: string, action: () => Promise<unknown>) {
    setBusyId(id)
    setError('')
    try {
      await action()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Source Version Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Version/rawEvidenceRef are immutable once created; lifecycle fields below are A3.3.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          placeholder="Rule Source UUID"
          aria-label="Rule Source UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          aria-label="Version"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={rawEvidenceRef}
          onChange={(event) => setRawEvidenceRef(event.target.value)}
          aria-label="Raw evidence reference"
        />
        <div className="flex gap-2">
          <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={saving} type="submit">
            {saving ? 'Saving...' : 'Create Version'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Versions'}
          </button>
        </div>
      </form>

      <div className="mt-4 grid grid-cols-2 gap-2 rounded-md bg-slate-50 p-3 sm:grid-cols-5">
        <input
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={publicationDate}
          onChange={(event) => setPublicationDate(event.target.value)}
          placeholder="publicationDate YYYY-MM-DD"
          aria-label="Publication date"
        />
        <input
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
          placeholder="effectiveFrom YYYY-MM-DD"
          aria-label="Effective from"
        />
        <input
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={effectiveTo}
          onChange={(event) => setEffectiveTo(event.target.value)}
          placeholder="effectiveTo YYYY-MM-DD (optional)"
          aria-label="Effective to"
        />
        <input
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={businessDate}
          onChange={(event) => setBusinessDate(event.target.value)}
          placeholder="businessDate YYYY-MM-DD"
          aria-label="Business date"
        />
        <input
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
          value={jurisdictionCode}
          onChange={(event) => setJurisdictionCode(event.target.value)}
          placeholder="jurisdictionCode"
          aria-label="Context jurisdiction code"
        />
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {versions && versions.length === 0 && <p className="mt-3 text-sm text-slate-600">No versions yet.</p>}

      {versions && versions.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded versions:</p>
          {versions.map((item) => {
            const busy = busyId === item.id
            const terminal = item.activationStatus === 'RETIRED'
            return (
              <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
                <p>
                  <strong>{item.version}</strong> — {item.rawEvidenceRef} — {item.id}
                </p>
                <p className="mt-1 text-xs text-slate-600">
                  publication={item.publicationStatus} verification={item.verificationStatus} activation=
                  <strong>{item.activationStatus}</strong> blockers=[{item.activationBlockers.join(', ')}]
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  publicationDate={item.publicationDate ?? '—'} effectiveFrom={item.effectiveFrom ?? '—'} effectiveTo={item.effectiveTo ?? '—'}
                </p>
                {previewBlockers[item.id] && (
                  <p className="mt-1 text-xs text-indigo-700">preview blockers=[{previewBlockers[item.id].join(', ')}]</p>
                )}
                {!terminal && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      className="rounded-md bg-slate-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={() => withBusy(item.id, () => updateLifecycleMetadata(item.id, publicationDate, effectiveFrom, effectiveTo))}
                    >
                      Set Lifecycle Metadata
                    </button>
                    <button
                      className="rounded-md bg-slate-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={() => withBusy(item.id, () => publishRuleSourceVersion(item.id))}
                    >
                      Publish
                    </button>
                    <button
                      className="rounded-md bg-slate-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={() => withBusy(item.id, () => updateSourceVerification(item.id, 'IN_REVIEW'))}
                    >
                      Verify: IN_REVIEW
                    </button>
                    <button
                      className="rounded-md bg-emerald-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={() => withBusy(item.id, () => updateSourceVerification(item.id, 'VERIFIED'))}
                    >
                      Verify: VERIFIED
                    </button>
                    <button
                      className="rounded-md bg-indigo-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={async () => {
                        setBusyId(item.id)
                        setError('')
                        try {
                          const result = await evaluateActivation(item.id, businessDate, jurisdictionCode)
                          setPreviewBlockers((prev) => ({ ...prev, [item.id]: result.blockers }))
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Request failed')
                        } finally {
                          setBusyId(null)
                        }
                      }}
                    >
                      Evaluate (preview)
                    </button>
                    {(item.activationStatus === 'INACTIVE' || item.activationStatus === 'BLOCKED') && (
                      <button
                        className="rounded-md bg-emerald-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                        disabled={busy}
                        onClick={() => withBusy(item.id, () => activateRuleSourceVersion(item.id, businessDate, jurisdictionCode))}
                      >
                        Activate
                      </button>
                    )}
                    {item.activationStatus === 'ACTIVE' && (
                      <button
                        className="rounded-md bg-amber-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                        disabled={busy}
                        onClick={() => withBusy(item.id, () => suspendRuleSourceVersion(item.id))}
                      >
                        Suspend
                      </button>
                    )}
                    {item.activationStatus === 'SUSPENDED' && (
                      <button
                        className="rounded-md bg-emerald-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                        disabled={busy}
                        onClick={() => withBusy(item.id, () => resumeRuleSourceVersion(item.id, businessDate, jurisdictionCode))}
                      >
                        Resume
                      </button>
                    )}
                    <button
                      className="rounded-md bg-red-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={busy}
                      onClick={() => withBusy(item.id, () => retireRuleSourceVersion(item.id))}
                    >
                      Retire
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
