import { useState, type FormEvent } from 'react'
import {
  activateRulePackVersion,
  addRulePackMember,
  createRulePack,
  createRulePackVersion,
  getRulePackVersion,
  listRulePackMembers,
  verifyRulePackVersion,
  type RulePack,
  type RulePackMember,
  type RulePackVersion,
} from './rule-pack.api.ts'

export default function RulePackCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [packKey, setPackKey] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [jurisdictionCode, setJurisdictionCode] = useState('AE-DU')
  const [pack, setPack] = useState<RulePack | null>(null)

  const [rulePackId, setRulePackId] = useState('')
  const [version, setVersion] = useState('v1')
  const [effectiveFrom, setEffectiveFrom] = useState('')
  const [effectiveTo, setEffectiveTo] = useState('')

  const [rulePackVersionId, setRulePackVersionId] = useState('')
  const [ruleVersionId, setRuleVersionId] = useState('')
  const [businessDate, setBusinessDate] = useState('2026-10-15')
  const [packVersion, setPackVersion] = useState<RulePackVersion | null>(null)
  const [members, setMembers] = useState<RulePackMember[] | null>(null)

  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleCreatePack(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createRulePack(organizationId, packKey, displayName, jurisdictionCode)
      setPack(created)
      setRulePackId(created.id)
    })
  }

  function handleCreateVersion(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createRulePackVersion(rulePackId, version, effectiveFrom, effectiveTo)
      setPackVersion(created)
      setRulePackVersionId(created.id)
      setMembers([])
    })
  }

  function refresh() {
    return run(async () => {
      setPackVersion(await getRulePackVersion(rulePackVersionId))
      setMembers(await listRulePackMembers(rulePackVersionId))
    })
  }

  function handleAddMember(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      await addRulePackMember(rulePackVersionId, ruleVersionId)
      setMembers(await listRulePackMembers(rulePackVersionId))
    })
  }

  const input = 'rounded-md border border-slate-300 px-3 py-2'
  const button = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Rule Pack Version Check (A3.9)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A rule pack only groups exact RuleVersions; it never decides which rule wins —
        that stays with the A3.8 resolution check above. A verified version is frozen, and only one version per pack can be ACTIVE.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreatePack}>
        <input className={input} value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} placeholder="Organization UUID" aria-label="Organization UUID" />
        <input className={input} value={packKey} onChange={(e) => setPackKey(e.target.value)} placeholder="packKey" aria-label="Pack key" />
        <input className={input} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="displayName" aria-label="Display name" />
        <input className={input} value={jurisdictionCode} onChange={(e) => setJurisdictionCode(e.target.value)} placeholder="jurisdictionCode" aria-label="Jurisdiction code" />
        <button className={button} disabled={busy} type="submit">Create Rule Pack</button>
      </form>
      {pack && (
        <p className="mt-2 text-sm">
          pack: {pack.id} — {pack.packKey} — {pack.jurisdictionCode} — {pack.ownershipScope}
        </p>
      )}

      <form className="mt-4 grid gap-2" onSubmit={handleCreateVersion}>
        <input className={input} value={rulePackId} onChange={(e) => setRulePackId(e.target.value)} placeholder="Rule Pack UUID" aria-label="Rule Pack UUID" />
        <input className={input} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="version label" aria-label="Version label" />
        <input className={input} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} placeholder="effectiveFrom (YYYY-MM-DD, optional)" aria-label="Effective from" />
        <input className={input} value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} placeholder="effectiveTo (YYYY-MM-DD, optional)" aria-label="Effective to" />
        <button className={button} disabled={busy} type="submit">Create Draft Version</button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleAddMember}>
        <input className={input} value={rulePackVersionId} onChange={(e) => setRulePackVersionId(e.target.value)} placeholder="Rule Pack Version UUID" aria-label="Rule Pack Version UUID" />
        <input className={input} value={ruleVersionId} onChange={(e) => setRuleVersionId(e.target.value)} placeholder="Rule Version UUID (exact member)" aria-label="Rule Version UUID" />
        <button className={button} disabled={busy} type="submit">Add Member</button>
      </form>

      <div className="mt-2 flex flex-wrap gap-2">
        <button className={button} disabled={busy} type="button" onClick={() => void refresh()}>Refresh Version</button>
        <button className={button} disabled={busy} type="button" onClick={() => void run(async () => setPackVersion(await verifyRulePackVersion(rulePackVersionId)))}>Verify</button>
        <input className={input} value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} placeholder="businessDate (YYYY-MM-DD)" aria-label="Activation business date" />
        <button className={button} disabled={busy} type="button" onClick={() => void run(async () => setPackVersion(await activateRulePackVersion(rulePackVersionId, businessDate)))}>Activate</button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {packVersion && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            version: {packVersion.version} — verification: <strong>{packVersion.verificationStatus}</strong> — activation:{' '}
            <strong>{packVersion.activationStatus}</strong>
          </p>
          <p>
            period: {packVersion.effectiveFrom ?? 'open'} → {packVersion.effectiveTo ?? 'open'}
          </p>
          <p>
            verifiedAt: {packVersion.verifiedAt ?? 'null'} — activatedAt: {packVersion.activatedAt ?? 'null'} — supersededAt:{' '}
            {packVersion.supersededAt ?? 'null'}
          </p>
          {members && <p>members (ruleVersionId): {members.map((m) => m.ruleVersionId).join(', ') || 'none'}</p>}
        </div>
      )}
    </section>
  )
}
