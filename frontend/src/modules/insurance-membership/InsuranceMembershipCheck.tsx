import { useState, type FormEvent } from 'react'
import {
  createMembership,
  getMembership,
  listMemberships,
  patchMembership,
  type InsuranceMembership,
  type MembershipInput,
} from './insurance-membership.api.ts'

// A4.3 — minimal developer check: create, list, get and patch a patient's insurance membership
// with synthetic IDs. It shows what was RECORDED — never an eligibility badge or an "active
// insurance" claim — and keeps nothing in browser storage. This is not the front-desk UI.

const emptyInput: MembershipInput = {
  payerId: '',
  tpaId: '',
  networkId: '',
  insuranceProductId: '',
  memberIdentifier: '',
  policyIdentifier: '',
  coverageFrom: '',
  coverageTo: '',
}

const patchableFields = ['payerId', 'tpaId', 'networkId', 'insuranceProductId', 'memberIdentifier', 'policyIdentifier', 'coverageFrom', 'coverageTo'] as const

export default function InsuranceMembershipCheck() {
  const [patientId, setPatientId] = useState('')
  const [input, setInput] = useState<MembershipInput>(emptyInput)
  const [membershipId, setMembershipId] = useState('')
  const [patchField, setPatchField] = useState<(typeof patchableFields)[number]>('policyIdentifier')
  const [patchValue, setPatchValue] = useState('')
  const [membership, setMembership] = useState<InsuranceMembership | null>(null)
  const [items, setItems] = useState<InsuranceMembership[] | null>(null)
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

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    void run(async () => {
      const created = await createMembership(patientId, input)
      setMembership(created)
      setMembershipId(created.id)
    })
  }

  const field = (key: keyof MembershipInput, placeholder: string) => (
    <input
      className="rounded-md border border-slate-300 px-3 py-2"
      value={input[key]}
      onChange={(event) => setInput({ ...input, [key]: event.target.value })}
      placeholder={placeholder}
      aria-label={placeholder}
    />
  )

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Insurance Membership Check (A4.3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A membership records which payer (and, when known, TPA, network and product), which member
        and policy identifiers, and which coverage dates were registered for a patient. A recorded coverage period is not payer
        verification: nothing here says the insurance is eligible, active or primary.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <input className={inputClass} value={patientId} onChange={(event) => setPatientId(event.target.value)} placeholder="Patient UUID" aria-label="Patient UUID" />
        {field('payerId', 'Payer UUID (required)')}
        {field('tpaId', 'TPA UUID (optional)')}
        {field('networkId', 'Network UUID (optional)')}
        {field('insuranceProductId', 'Insurance product UUID (optional)')}
        {field('memberIdentifier', 'Member identifier (synthetic, required)')}
        {field('policyIdentifier', 'Policy identifier (synthetic, optional)')}
        {field('coverageFrom', 'Recorded coverage from (YYYY-MM-DD, blank = unknown)')}
        {field('coverageTo', 'Recorded coverage to (YYYY-MM-DD, blank = unknown)')}
        <button className={buttonClass} disabled={busy} type="submit">
          Create Membership
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setItems(await listMemberships(patientId)))}>
          List Memberships
        </button>
        <input className={inputClass} value={membershipId} onChange={(event) => setMembershipId(event.target.value)} placeholder="Membership UUID" aria-label="Membership UUID" />
        <button className={buttonClass} disabled={busy} type="button" onClick={() => void run(async () => setMembership(await getMembership(membershipId)))}>
          Get Membership
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <select className={inputClass} value={patchField} onChange={(event) => setPatchField(event.target.value as (typeof patchableFields)[number])} aria-label="Field to patch">
          {patchableFields.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <input className={inputClass} value={patchValue} onChange={(event) => setPatchValue(event.target.value)} placeholder="new value (blank = clear)" aria-label="New value" />
        <button
          className={buttonClass}
          disabled={busy}
          type="button"
          onClick={() => void run(async () => setMembership(await patchMembership(membershipId, { [patchField]: patchValue.trim() === '' ? null : patchValue })))}
        >
          Patch Membership
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {membership && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm">
          <p>
            id: {membership.id} — patientId: {membership.patientId}
          </p>
          <p>
            payer: {membership.payerId} — tpa: {membership.tpaId ?? 'unknown'} — network: {membership.networkId ?? 'unknown'} — product:{' '}
            {membership.insuranceProductId ?? 'unknown'}
          </p>
          <p>
            member: {membership.memberIdentifier} — policy: {membership.policyIdentifier ?? 'not recorded'}
          </p>
          <p>
            recorded period (not verification): {membership.coverageFrom ?? 'unknown'} → {membership.coverageTo ?? 'unknown'}
          </p>
        </div>
      )}

      {items && (
        <div className="mt-3 text-sm text-slate-700">
          <p>{items.length} membership record(s) for this patient:</p>
          <ul className="mt-1 list-disc pl-5">
            {items.map((item) => (
              <li key={item.id}>
                {item.id} — payer {item.payerId} — recorded {item.coverageFrom ?? 'unknown'} → {item.coverageTo ?? 'unknown'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
