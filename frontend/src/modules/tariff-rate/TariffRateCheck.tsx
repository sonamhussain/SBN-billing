import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.3 — minimal engineering check for governed tariff rates: add a rate to an UNVERIFIED tariff version,
// list a version's rates and retire one. Synthetic development data only. Amounts are sent and shown as
// decimal strings, never JavaScript numbers. Only SBN UUIDs appear in a path, nothing travels in a query
// string, nothing is logged and nothing is kept in browser storage. Administrative rate maintenance UX
// belongs to FE-05; this page is not that product screen.

type TariffRateSummary = {
  id: string
  selectorKind: string
  serviceId: string | null
  procedureCodeId: string | null
  unitCodeKey: string | null
  modifierCodes: string[]
  currencyCode: string
  unitTariffAmount: string
  removedAt: string | null
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const codeList = (value: string) => value.split(/[\s,]+/).map((code) => code.trim()).filter((code) => code !== '')

export default function TariffRateCheck() {
  const [versionId, setVersionId] = useState('')
  const [selectorKind, setSelectorKind] = useState<'SERVICE' | 'PROCEDURE_CODE'>('PROCEDURE_CODE')
  const [masterId, setMasterId] = useState('')
  const [unitCodeKey, setUnitCodeKey] = useState('')
  const [modifiers, setModifiers] = useState('')
  const [amount, setAmount] = useState('')
  const [rateId, setRateId] = useState('')
  const [rates, setRates] = useState<TariffRateSummary[] | null>(null)
  const [rate, setRate] = useState<TariffRateSummary | null>(null)
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
    void run(async () => setRates((await handle<{ items: TariffRateSummary[] }>(await fetch(`/api/tariff-schedule-versions/${versionId.trim()}/rates`))).items))
  }

  function handleCreate(event: FormEvent) {
    event.preventDefault()
    const body = {
      selectorKind,
      ...(selectorKind === 'SERVICE' ? { serviceId: masterId.trim() } : { procedureCodeId: masterId.trim() }),
      unitCodeKey: unitCodeKey.trim() === '' ? null : unitCodeKey.trim(),
      modifierCodes: codeList(modifiers),
      currencyCode: 'AED',
      unitTariffAmount: amount.trim(),
    }
    void run(async () => setRate(await handle<TariffRateSummary>(await fetch(`/api/tariff-schedule-versions/${versionId.trim()}/rates`, post(body)))))
  }

  function handleRetire(event: FormEvent) {
    event.preventDefault()
    void run(async () => setRate(await handle<TariffRateSummary>(await fetch(`/api/tariff-rates/${rateId.trim()}/retire`, post({})))))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const describe = (item: TariffRateSummary) =>
    `${item.id} — ${item.selectorKind} ${item.serviceId ?? item.procedureCodeId} — unit ${item.unitCodeKey ?? 'none'} — modifiers [${item.modifierCodes.join(', ')}] — ${item.currencyCode} ${item.unitTariffAmount}${item.removedAt ? ' — retired' : ''}`

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Tariff Rate Check (A6.3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Rates are added or retired only while the tariff version is UNVERIFIED. An amount is a tariff amount, not payer Net
        or patient share.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <input className={inputClass} value={versionId} onChange={(event) => setVersionId(event.target.value)} placeholder="Tariff schedule version UUID" aria-label="Tariff schedule version UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List rates
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleCreate}>
        <select className={inputClass} value={selectorKind} onChange={(event) => setSelectorKind(event.target.value as 'SERVICE' | 'PROCEDURE_CODE')} aria-label="Selector kind">
          <option value="PROCEDURE_CODE">PROCEDURE_CODE</option>
          <option value="SERVICE">SERVICE</option>
        </select>
        <input className={inputClass} value={masterId} onChange={(event) => setMasterId(event.target.value)} placeholder="Service or procedure code UUID" aria-label="Rated identity UUID" />
        <input className={inputClass} value={unitCodeKey} onChange={(event) => setUnitCodeKey(event.target.value)} placeholder="Unit code (empty for no unit)" aria-label="Unit code" />
        <input className={inputClass} value={modifiers} onChange={(event) => setModifiers(event.target.value)} placeholder="Modifier codes (empty for none)" aria-label="Modifier codes" />
        <input className={inputClass} value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="AED amount per unit, e.g. 125.2500" aria-label="Unit tariff amount" />
        <button className={buttonClass} disabled={busy} type="submit">
          Add AED rate to the version above
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRetire}>
        <input className={inputClass} value={rateId} onChange={(event) => setRateId(event.target.value)} placeholder="Tariff rate UUID" aria-label="Tariff rate UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Retire rate
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}
      {rate && <p className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">{describe(rate)}</p>}
      {rates && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{rates.length} rate(s), active and retired, in creation order</p>
          <ul className="mt-1 grid gap-1">
            {rates.map((item) => (
              <li key={item.id}>{describe(item)}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
