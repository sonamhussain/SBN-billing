import { useState, type FormEvent } from 'react'
import {
  createRuleVersion,
  loadRuleVersions,
  ruleEffectTypes,
  updateRuleVersionVerification,
  type RuleEffectType,
  type RuleVersion,
} from './rule-version.api.ts'

export default function RuleVersionCheck() {
  const [ruleId, setRuleId] = useState('')
  const [version, setVersion] = useState('1')
  const [effectType, setEffectType] = useState<RuleEffectType>('CLAIM_FORMAT_EFFECT')
  const [effectiveFrom, setEffectiveFrom] = useState('2026-10-01')
  const [effectiveTo, setEffectiveTo] = useState('')
  const [verifyId, setVerifyId] = useState('')
  const [verificationStatus, setVerificationStatus] = useState('IN_REVIEW')
  const [ruleVersions, setRuleVersions] = useState<RuleVersion[] | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [verifying, setVerifying] = useState(false)

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await createRuleVersion(ruleId, version, effectType, effectiveFrom, effectiveTo)
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
      setRuleVersions(await loadRuleVersions(ruleId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(event: FormEvent) {
    event.preventDefault()
    setVerifying(true)
    setError('')
    try {
      await updateRuleVersionVerification(verifyId, verificationStatus)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Version Check</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. VERIFIED != executable — no activation exists here.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={ruleId}
          onChange={(event) => setRuleId(event.target.value)}
          placeholder="Rule Definition UUID"
          aria-label="Rule Definition UUID"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={version}
          onChange={(event) => setVersion(event.target.value)}
          aria-label="Version"
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2"
          value={effectType}
          onChange={(event) => setEffectType(event.target.value as RuleEffectType)}
          aria-label="Effect type"
        >
          {ruleEffectTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
          placeholder="effectiveFrom (YYYY-MM-DD)"
          aria-label="Effective from"
        />
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={effectiveTo}
          onChange={(event) => setEffectiveTo(event.target.value)}
          placeholder="effectiveTo (YYYY-MM-DD, optional)"
          aria-label="Effective to"
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
            disabled={saving}
            type="submit"
          >
            {saving ? 'Saving...' : 'Create Rule Version'}
          </button>
          <button
            className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={loading}
            type="button"
            onClick={handleLoad}
          >
            {loading ? 'Loading...' : 'Load Rule Versions'}
          </button>
        </div>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleVerify}>
        <input
          className="rounded-md border border-slate-300 px-3 py-2"
          value={verifyId}
          onChange={(event) => setVerifyId(event.target.value)}
          placeholder="Rule Version UUID to verify"
          aria-label="Rule Version UUID to verify"
        />
        <select
          className="rounded-md border border-slate-300 px-3 py-2"
          value={verificationStatus}
          onChange={(event) => setVerificationStatus(event.target.value)}
          aria-label="Verification status"
        >
          <option value="IN_REVIEW">IN_REVIEW</option>
          <option value="VERIFIED">VERIFIED</option>
          <option value="REJECTED">REJECTED</option>
        </select>
        <button
          className="rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={verifying}
          type="submit"
        >
          {verifying ? 'Updating...' : 'Update Verification'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {ruleVersions && ruleVersions.length === 0 && <p className="mt-3 text-sm text-slate-600">No rule versions yet.</p>}

      {ruleVersions && ruleVersions.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">Loaded rule versions:</p>
          {ruleVersions.map((item) => (
            <div key={item.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p>
                <strong>{item.version}</strong> — {item.effectType} — {item.verificationStatus} — {item.id}
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
