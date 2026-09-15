import { useState, type FormEvent } from 'react'
import {
  createContractFacility,
  createInsuranceProduct,
  createProviderContract,
  createTariffSchedule,
  createTariffScheduleVersion,
} from './commercial-coverage.api.ts'

export default function CommercialCoverageCheck() {
  const [organizationId, setOrganizationId] = useState('')
  const [payerId, setPayerId] = useState('')
  const [facilityId, setFacilityId] = useState('')
  const [productCode, setProductCode] = useState('')
  const [contractKey, setContractKey] = useState('')
  const [tariffKey, setTariffKey] = useState('')
  const [tariffVersion, setTariffVersion] = useState('1')
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState('')
  const [running, setRunning] = useState(false)

  async function handleRunChain(event: FormEvent) {
    event.preventDefault()
    setRunning(true)
    setError('')
    setLog([])
    try {
      const product = await createInsuranceProduct(organizationId, payerId, productCode, `${productCode} plan`)
      const contract = await createProviderContract(organizationId, contractKey, `${contractKey} contract`, product.id)
      const contractFacility = await createContractFacility(contract.id, facilityId)
      const schedule = await createTariffSchedule(contract.id, tariffKey, `${tariffKey} schedule`)
      const version = await createTariffScheduleVersion(schedule.id, tariffVersion)
      setLog([
        `InsuranceProduct created: ${product.id}`,
        `ProviderContract created: ${contract.id} (insuranceProductId=${contract.insuranceProductId})`,
        `ContractFacility created: ${contractFacility.id}`,
        `TariffSchedule created: ${schedule.id}`,
        `TariffScheduleVersion created: ${version.id} (verificationStatus=${version.verificationStatus})`,
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Commercial Coverage Check (REF-01 / R2)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only. Runs the full chain: Product -&gt; Contract -&gt; Facility -&gt; TariffScheduleVersion.
        No pricing/rate data. No DELETE.
      </p>

      <form className="mt-3 grid gap-2" onSubmit={handleRunChain}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} placeholder="Organization UUID" aria-label="Organization UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={payerId} onChange={(e) => setPayerId(e.target.value)} placeholder="Payer UUID" aria-label="Payer UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} placeholder="Facility UUID" aria-label="Facility UUID" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={productCode} onChange={(e) => setProductCode(e.target.value)} placeholder="productCode" aria-label="Product code" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={contractKey} onChange={(e) => setContractKey(e.target.value)} placeholder="contractKey" aria-label="Contract key" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={tariffKey} onChange={(e) => setTariffKey(e.target.value)} placeholder="tariffKey" aria-label="Tariff key" />
        <input className="rounded-md border border-slate-300 px-3 py-2" value={tariffVersion} onChange={(e) => setTariffVersion(e.target.value)} placeholder="tariff version" aria-label="Tariff version" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={running} type="submit">
          {running ? 'Running...' : 'Run Chain'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {log.length > 0 && (
        <div className="mt-4 space-y-1">
          {log.map((line, index) => (
            <p key={index} className="rounded-md bg-slate-100 p-2 text-sm">
              {line}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
