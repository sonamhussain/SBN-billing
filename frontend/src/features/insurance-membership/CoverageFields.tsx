import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Select } from '../../shared/ui/Select.tsx'
import type { useCoverageMasters } from './coverage-labels.ts'
import type { CoverageDraft } from './coverage-draft.ts'

// The coverage form shared by create and edit. Every master is chosen from the organization's real
// options; no UUID is ever typed. An empty string means "Not recorded". Products are filtered by the
// selected payer for usability only; the backend still decides whether a combination is coherent.
type Masters = ReturnType<typeof useCoverageMasters>

export function CoverageFields({
  draft,
  onChange,
  masters,
}: {
  draft: CoverageDraft
  onChange: (next: CoverageDraft) => void
  masters: Masters
}) {
  const set = (key: keyof CoverageDraft) => (value: string) => onChange({ ...draft, [key]: value })
  const productsForPayer = (masters.products.data ?? []).filter((product) => product.payerId === draft.payerId)

  function choosePayer(payerId: string) {
    // A product recorded under another payer is cleared rather than silently kept; nothing is inferred.
    const keepProduct = (masters.products.data ?? []).some((p) => p.id === draft.insuranceProductId && p.payerId === payerId)
    onChange({ ...draft, payerId, insuranceProductId: keepProduct ? draft.insuranceProductId : '' })
  }

  const unavailable = masters.payers.isError || masters.tpas.isError || masters.networks.isError || masters.products.isError

  return (
    <>
      {unavailable && <p className="text-sm text-red-700">Some coverage options could not be loaded.</p>}
      <Field label="Payer">
        <Select required value={draft.payerId} onChange={(e) => choosePayer(e.target.value)} disabled={masters.payers.isPending}>
          <option value="">{masters.payers.isPending ? 'Loading...' : 'Select a payer'}</option>
          {(masters.payers.data ?? []).map((payer) => (
            <option key={payer.id} value={payer.id}>
              {payer.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Insurance product" hint="(optional)">
        <Select value={draft.insuranceProductId} onChange={(e) => set('insuranceProductId')(e.target.value)} disabled={draft.payerId === ''}>
          <option value="">Not recorded</option>
          {productsForPayer.map((product) => (
            <option key={product.id} value={product.id}>
              {product.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="TPA" hint="(optional)">
        <Select value={draft.tpaId} onChange={(e) => set('tpaId')(e.target.value)}>
          <option value="">Not recorded</option>
          {(masters.tpas.data ?? []).map((tpa) => (
            <option key={tpa.id} value={tpa.id}>
              {tpa.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Network" hint="(optional)">
        <Select value={draft.networkId} onChange={(e) => set('networkId')(e.target.value)}>
          <option value="">Not recorded</option>
          {(masters.networks.data ?? []).map((network) => (
            <option key={network.id} value={network.id}>
              {network.displayName}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Member identifier">
        <Input required autoComplete="off" value={draft.memberIdentifier} onChange={(e) => set('memberIdentifier')(e.target.value)} />
      </Field>
      <Field label="Policy identifier" hint="(optional)">
        <Input autoComplete="off" value={draft.policyIdentifier} onChange={(e) => set('policyIdentifier')(e.target.value)} />
      </Field>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Recorded coverage from" hint="(optional)">
          <Input type="date" value={draft.coverageFrom} onChange={(e) => set('coverageFrom')(e.target.value)} />
        </Field>
        <Field label="Recorded coverage to" hint="(optional)">
          <Input type="date" value={draft.coverageTo} onChange={(e) => set('coverageTo')(e.target.value)} />
        </Field>
      </div>
    </>
  )
}
