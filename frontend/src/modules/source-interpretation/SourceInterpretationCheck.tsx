import { useState, type FormEvent } from 'react'
import {
  createSourceInterpretation,
  loadSourceInterpretations,
  updateSourceInterpretationStatus,
  type SourceInterpretation,
  type VerificationStatus,
} from './source-interpretation.api.ts'

export default function SourceInterpretationCheck() {
  const [sourceVersionId, setSourceVersionId] = useState('')
  const [interpretationVersion, setInterpretationVersion] = useState('1')
  const [normalizedInterpretationRef, setNormalizedInterpretationRef] = useState(
    'synthetic-interpretation://rule-source-version/demo/v1',
  )
  const [interpretations, setInterpretations] = useState<SourceInterpretation[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [advancingId, setAdvancingId] = useState<string | null>(null)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createSourceInterpretation(sourceVersionId, interpretationVersion, normalizedInterpretationRef)
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
      setInterpretations(await loadSourceInterpretations(sourceVersionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleAdvance(id: string, nextStatus: VerificationStatus) {
    setAdvancingId(id)
    setError('')
    try {
      await updateSourceInterpretationStatus(id, nextStatus)
      setInterpretations(await loadSourceInterpretations(sourceVersionId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setAdvancingId(null)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Source Interpretation Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. New interpretations start UNVERIFIED; VERIFIED/REJECTED are terminal.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={sourceVersionId}
          onChange={(event) => setSourceVersionId(event.target.value)}
          placeholder="Rule Source Version UUID"
          aria-label="Rule Source Version UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={interpretationVersion}
          onChange={(event) => setInterpretationVersion(event.target.value)}
          aria-label="Interpretation version"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={normalizedInterpretationRef}
          onChange={(event) => setNormalizedInterpretationRef(event.target.value)}
          aria-label="Normalized interpretation reference"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Interpretation'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Interpretations'}
          </button>
        </div>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {interpretations && interpretations.length === 0 && (
        <p className="mt-3 text-sm text-slate-600">No interpretations yet.</p>
      )}

      {interpretations && interpretations.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded interpretations:</p>
          {interpretations.map((item) => {
            const terminal = item.verificationStatus === 'VERIFIED' || item.verificationStatus === 'REJECTED'
            return (
              <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
                <p>
                  <strong>{item.interpretationVersion}</strong> — {item.verificationStatus} — {item.verifiedAt ?? 'not verified'} — {item.id}
                </p>
                {!terminal && (
                  <div className="mt-2 flex gap-2">
                    <button
                      className="rounded-md bg-slate-600 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={advancingId === item.id}
                      onClick={() => handleAdvance(item.id, 'IN_REVIEW')}
                    >
                      Move to IN_REVIEW
                    </button>
                    <button
                      className="rounded-md bg-emerald-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={advancingId === item.id}
                      onClick={() => handleAdvance(item.id, 'VERIFIED')}
                    >
                      Verify
                    </button>
                    <button
                      className="rounded-md bg-red-700 px-3 py-1 text-xs text-white disabled:opacity-50"
                      disabled={advancingId === item.id}
                      onClick={() => handleAdvance(item.id, 'REJECTED')}
                    >
                      Reject
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
