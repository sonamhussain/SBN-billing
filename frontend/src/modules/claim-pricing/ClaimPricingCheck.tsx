import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.3 — minimal engineering check for draft pricing runs: price a Claim against its bound tariff version,
// list a Claim's pricing runs and read one. Synthetic development data only. Only ids, outcomes and
// amounts are shown — no patient, member, payer or clinical value. A PRICED run is a draft calculation;
// it is not approval, payer Net, patient share or a submission. Nothing is logged or kept in browser
// storage, and no product pricing screen is built here (FE-04 owns that later).

type PricingLine = {
  claimLineId: string
  lineSequenceAtEvaluation: number
  outcome: string
  quantityAtEvaluation: string
  unitTariffAmount: string | null
  extendedTariffAmount: string | null
  currencyCode: string | null
}

type PricingRun = {
  id: string
  overallResult: string
  lineCount: number
  pricedCount: number
  currencyCode: string | null
  totalExtendedTariffAmount: string | null
  evaluatedAt: string
  lines?: PricingLine[]
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export default function ClaimPricingCheck() {
  const [claimId, setClaimId] = useState('')
  const [pricingRunId, setPricingRunId] = useState('')
  const [runs, setRuns] = useState<PricingRun[] | null>(null)
  const [pricingRun, setPricingRun] = useState<PricingRun | null>(null)
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

  function handlePrice(event: FormEvent) {
    event.preventDefault()
    void run(async () =>
      setPricingRun(await handle<PricingRun>(await fetch(`/api/claims/${claimId.trim()}/pricing-runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))),
    )
  }

  function handleList(event: FormEvent) {
    event.preventDefault()
    void run(async () => setRuns((await handle<{ items: PricingRun[] }>(await fetch(`/api/claims/${claimId.trim()}/pricing-runs`))).items))
  }

  function handleRead(event: FormEvent) {
    event.preventDefault()
    void run(async () => setPricingRun(await handle<PricingRun>(await fetch(`/api/claim-pricing-runs/${pricingRunId.trim()}`))))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'
  const total = (item: PricingRun) => (item.totalExtendedTariffAmount === null ? 'no total' : `${item.currencyCode} ${item.totalExtendedTariffAmount}`)

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Pricing Check (A6.3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. A pricing run is an immutable draft calculation against the Claim&apos;s bound tariff version; it confers no approval
        or submission.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handlePrice}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Price claim
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleList}>
        <button className={buttonClass} disabled={busy} type="submit">
          List pricing runs of the claim above
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className={inputClass} value={pricingRunId} onChange={(event) => setPricingRunId(event.target.value)} placeholder="Pricing run UUID" aria-label="Pricing run UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Read pricing run
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {pricingRun && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Run {pricingRun.id} — {pricingRun.overallResult} — {pricingRun.pricedCount}/{pricingRun.lineCount} priced — {total(pricingRun)}
          </p>
          <ul className="mt-1 grid gap-1">
            {(pricingRun.lines ?? []).map((line) => (
              <li key={line.claimLineId}>
                {line.lineSequenceAtEvaluation}. {line.claimLineId} — {line.outcome} — qty {line.quantityAtEvaluation}
                {line.extendedTariffAmount === null ? '' : ` — ${line.currencyCode} ${line.unitTariffAmount} each = ${line.extendedTariffAmount}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {runs && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{runs.length} pricing run(s), newest first (history order, not a current price)</p>
          <ul className="mt-1 grid gap-1">
            {runs.map((item) => (
              <li key={item.id}>
                {item.id} — {item.overallResult} — {item.pricedCount}/{item.lineCount} — {total(item)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
