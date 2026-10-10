import { useOwnerRecord } from '../admin/owner-query.ts'

// FE-05 — the context dimensions a governed record names (a source scope or a rule applicability): each
// non-empty dimension is shown with the name its owner record gives it, read by ID. Nothing here matches,
// ranks or evaluates; the record is shown exactly as stored. A dimension the user cannot read says
// "Unavailable", never the raw identifier.

type Reader = { label: string; path: string; permission: string; name: (record: Record<string, unknown>) => string }

const text = (record: Record<string, unknown>, key: string) => String(record[key] ?? '')

const readers: Record<string, Reader> = {
  facilityId: { label: 'Facility', path: 'facilities', permission: 'facility.read', name: (r) => text(r, 'name') },
  facilityRegulatoryProfileId: {
    label: 'Regulatory profile',
    path: 'facility-regulatory-profiles',
    permission: 'facility_regulatory_profile.read',
    name: (r) => `${text(r, 'jurisdictionCode')} / ${text(r, 'regulatoryAuthorityCode')} · ${text(r, 'status')}`,
  },
  payerId: { label: 'Payer', path: 'payers', permission: 'payer.read', name: (r) => text(r, 'displayName') },
  tpaId: { label: 'TPA', path: 'tpas', permission: 'tpa.read', name: (r) => text(r, 'displayName') },
  networkId: { label: 'Network', path: 'networks', permission: 'network.read', name: (r) => text(r, 'displayName') },
  insuranceProductId: {
    label: 'Insurance product',
    path: 'insurance-products',
    permission: 'insurance_product.read',
    name: (r) => `${text(r, 'productCode')} — ${text(r, 'displayName')}`,
  },
  providerContractId: { label: 'Provider contract', path: 'provider-contracts', permission: 'provider_contract.read', name: (r) => text(r, 'displayName') },
  tariffScheduleId: { label: 'Tariff schedule', path: 'tariff-schedules', permission: 'tariff_schedule.read', name: (r) => text(r, 'displayName') },
  tariffScheduleVersionId: {
    label: 'Tariff version',
    path: 'tariff-schedule-versions',
    permission: 'tariff_schedule_version.read',
    name: (r) => `${text(r, 'version')} · ${text(r, 'verificationStatus')}`,
  },
  serviceId: { label: 'Service', path: 'services', permission: 'service.read', name: (r) => `${text(r, 'internalCode')} — ${text(r, 'displayName')}` },
  procedureCodeId: {
    label: 'Procedure',
    path: 'procedure-codes',
    permission: 'procedure_code.read',
    name: (r) => `${text(r, 'internalCode')} — ${text(r, 'displayName')}`,
  },
  diagnosisCodeId: { label: 'Diagnosis', path: 'diagnosis-codes', permission: 'diagnosisCode.read', name: (r) => `${text(r, 'code')} — ${text(r, 'displayName')}` },
}

function DimensionValue({ reader, id }: { reader: Reader; id: string }) {
  const record = useOwnerRecord<Record<string, unknown>>(`/api/${reader.path}/${id}`, reader.permission)
  if (!record.permitted || record.isError) return <>Unavailable</>
  return <>{record.data ? reader.name(record.data) : 'Loading...'}</>
}

export function GovernedDimensions({ record }: { record: Record<string, unknown> }) {
  const present = Object.entries(readers).filter(([key]) => typeof record[key] === 'string' && record[key] !== '')
  if (present.length === 0) return <p className="text-xs text-slate-500">No context dimension recorded.</p>
  return (
    <dl className="grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
      {present.map(([key, reader]) => (
        <div key={key}>
          <dt className="inline text-slate-500">{reader.label}: </dt>
          <dd className="inline text-slate-700">
            <DimensionValue reader={reader} id={record[key] as string} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
