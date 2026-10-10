import { useState, type FormEvent } from 'react'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { formatDateOnly } from '../../shared/format/date.ts'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Alert } from '../../shared/ui/Alert.tsx'
import { Button } from '../../shared/ui/Button.tsx'
import { Dialog } from '../../shared/ui/Dialog.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import { Sheet } from '../../shared/ui/Sheet.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { OptionPicker } from '../encounter-lookups/OptionPicker.tsx'
import { useFacilityName } from '../encounter-lookups/encounter-lookups.queries.ts'
import { LoadedList } from '../admin/LoadedList.tsx'
import { MasterFormDialog } from '../admin/MasterFormDialog.tsx'
import { useMasterList, useMasterMutations, type MasterOwner } from '../admin/master-api.ts'
import { useOwnerItems } from '../admin/owner-query.ts'
import { TariffSchedules } from './TariffSchedules.tsx'

// FE-05 — Provider contracts (REF-01): a contract identity with its payer (chosen by name), optional TPA,
// network and insurance product, a contract key and effective period. Only the display name is editable
// after creation. A contract's tariff schedules and versions are managed inside it; its facilities are
// shown read-only because adding one needs a complete facility chooser the backend does not offer yet.
// There is no pricing anywhere.

type Named = { id: string; displayName: string }
type Product = Named & { payerId: string; productCode: string }
type ProviderContract = {
  id: string
  payerId: string
  tpaId: string | null
  networkId: string | null
  insuranceProductId: string | null
  contractKey: string
  displayName: string
  effectiveFrom: string
  effectiveTo: string | null
}
type ContractFacility = { id: string; facilityId: string }

const contractOwner: MasterOwner = {
  collection: 'provider-contracts',
  read: 'provider_contract.read',
  create: 'provider_contract.create',
  update: 'provider_contract.update',
}
const owners = {
  payers: { collection: 'payers', read: 'payer.read', create: 'payer.create', update: 'payer.update' },
  tpas: { collection: 'tpas', read: 'tpa.read', create: 'tpa.create', update: 'tpa.update' },
  networks: { collection: 'networks', read: 'network.read', create: 'network.create', update: 'network.update' },
  products: { collection: 'insurance-products', read: 'insurance_product.read', create: 'insurance_product.create', update: 'insurance_product.update' },
} satisfies Record<string, MasterOwner>

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
const linkButton = 'rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100'
const period = (from: string, to: string | null) => `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

type Draft = { contractKey: string; displayName: string; payerId: string; tpaId: string; networkId: string; insuranceProductId: string; effectiveFrom: string; effectiveTo: string }
const emptyDraft: Draft = { contractKey: '', displayName: '', payerId: '', tpaId: '', networkId: '', insuranceProductId: '', effectiveFrom: '', effectiveTo: '' }

function useCommercialMasters(organizationId: string) {
  return {
    payers: useMasterList<Named>(owners.payers, organizationId),
    tpas: useMasterList<Named>(owners.tpas, organizationId),
    networks: useMasterList<Named>(owners.networks, organizationId),
    products: useMasterList<Product>(owners.products, organizationId),
  }
}

function CreateContractDialog() {
  const { organizationId } = useOrganization()
  const masters = useCommercialMasters(organizationId)
  const { create } = useMasterMutations<ProviderContract>(contractOwner, organizationId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const options = (query: { data: Named[] | undefined }) => query.data?.map((item) => ({ value: item.id, label: item.displayName }))
  const state = (query: { isPending: boolean; isError: boolean; permitted: boolean }) => ({
    loading: query.isPending && query.permitted,
    unavailable: !query.permitted || query.isError,
  })
  // Products are offered for the chosen payer for usability; the backend still decides coherence.
  const products = masters.products.data?.filter((product) => product.payerId === draft.payerId)

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDraft(emptyDraft)
    create.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await create.mutateAsync({
        contractKey: draft.contractKey,
        displayName: draft.displayName,
        payerId: draft.payerId,
        tpaId: draft.tpaId || null,
        networkId: draft.networkId || null,
        insuranceProductId: draft.insuranceProductId || null,
        effectiveFrom: draft.effectiveFrom,
        effectiveTo: draft.effectiveTo || null,
      })
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state.
    }
  }

  return (
    <Dialog title="New provider contract" open={open} onOpenChange={onOpenChange} trigger={<Button className={secondaryButton}>New provider contract</Button>}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Provider contract')}</Alert>}
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Contract key">
            <Input required autoComplete="off" value={draft.contractKey} onChange={(e) => setDraft({ ...draft, contractKey: e.target.value })} />
          </Field>
          <Field label="Display name">
            <Input required autoComplete="off" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
          </Field>
        </div>
        <OptionPicker
          label="Payer"
          required
          value={draft.payerId}
          onChange={(payerId) => setDraft({ ...draft, payerId, insuranceProductId: '' })}
          options={options(masters.payers)}
          placeholder="Select a payer"
          {...state(masters.payers)}
        />
        <OptionPicker label="TPA" hint="(optional)" value={draft.tpaId} onChange={(tpaId) => setDraft({ ...draft, tpaId })} options={options(masters.tpas)} placeholder="Not recorded" {...state(masters.tpas)} />
        <OptionPicker
          label="Network"
          hint="(optional)"
          value={draft.networkId}
          onChange={(networkId) => setDraft({ ...draft, networkId })}
          options={options(masters.networks)}
          placeholder="Not recorded"
          {...state(masters.networks)}
        />
        <OptionPicker
          label="Insurance product"
          hint="(optional, products of the chosen payer)"
          value={draft.insuranceProductId}
          onChange={(insuranceProductId) => setDraft({ ...draft, insuranceProductId })}
          options={products?.map((product) => ({ value: product.id, label: `${product.productCode} — ${product.displayName}` }))}
          placeholder={draft.payerId === '' ? 'Select a payer first' : 'Not recorded'}
          disabled={draft.payerId === ''}
          {...state(masters.products)}
        />
        <div className="grid items-end gap-3 sm:grid-cols-2">
          <Field label="Effective from">
            <Input type="date" required value={draft.effectiveFrom} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
          </Field>
          <Field label="Effective to" hint="(optional)">
            <Input type="date" value={draft.effectiveTo} onChange={(e) => setDraft({ ...draft, effectiveTo: e.target.value })} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending || draft.payerId === ''}>
            {create.isPending ? 'Saving...' : 'Create provider contract'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function FacilityName({ facilityId }: { facilityId: string }) {
  return <>{useFacilityName(facilityId)}</>
}

function ContractFacilities({ contractId }: { contractId: string }) {
  const facilities = useOwnerItems<ContractFacility>(`/api/provider-contracts/${contractId}/contract-facilities`, 'contract_facility.read')
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-950">Facilities</h3>
      <p className="text-xs text-slate-500">Recorded facilities, read-only. Adding a facility needs a complete facility chooser, which is not available yet.</p>
      {!facilities.permitted && <EmptyState title="Contract facilities are not available to you." />}
      {facilities.permitted && facilities.isPending && <Skeleton className="h-8 w-full" />}
      {facilities.isError && <p className="text-sm text-red-700">Contract facilities could not be loaded.</p>}
      {facilities.data &&
        (facilities.data.length === 0 ? (
          <p className="text-sm text-slate-500">No facility recorded for this contract.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white text-sm">
            {facilities.data.map((link) => (
              <li key={link.id} className="px-3 py-2">
                <FacilityName facilityId={link.facilityId} />
              </li>
            ))}
          </ul>
        ))}
    </section>
  )
}

function ContractSheet({ contract, summary }: { contract: ProviderContract; summary: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      title={contract.displayName}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className={linkButton}>
          Details
        </button>
      }
    >
      <p className="mb-6 text-sm text-slate-500">{summary}</p>
      {open && (
        <div className="space-y-8">
          <TariffSchedules contractId={contract.id} />
          <ContractFacilities contractId={contract.id} />
        </div>
      )}
    </Sheet>
  )
}

export function ProviderContracts() {
  const { organizationId } = useOrganization()
  const contracts = useMasterList<ProviderContract>(contractOwner, organizationId)
  const payers = useMasterList<Named>(owners.payers, organizationId)
  const { update } = useMasterMutations<ProviderContract>(contractOwner, organizationId)
  const payerName = (id: string) =>
    !payers.permitted ? 'Unavailable' : payers.isPending ? 'Loading...' : (payers.data?.find((payer) => payer.id === id)?.displayName ?? 'Unavailable')

  return (
    <section aria-label="Provider contracts" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-base font-semibold text-slate-950">Provider contracts</h3>
        <PermissionGate permission={contractOwner.create}>
          <CreateContractDialog />
        </PermissionGate>
      </div>
      <LoadedList
        noun="provider contracts"
        query={contracts}
        rowKey={(item) => item.id}
        filterText={(item) => `${item.contractKey} ${item.displayName} ${payerName(item.payerId)}`}
        emptyTitle="No provider contracts recorded"
        renderRow={(item) => {
          const summary = `${payerName(item.payerId)} · ${item.contractKey} · ${period(item.effectiveFrom, item.effectiveTo)}`
          return (
            <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-950">{item.displayName}</p>
                <p className="truncate text-xs text-slate-500">{summary}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ContractSheet contract={item} summary={summary} />
                <PermissionGate permission={contractOwner.update}>
                  <MasterFormDialog
                    title="Rename provider contract"
                    subject="Provider contract"
                    fields={[{ key: 'displayName', label: 'Display name', required: true }]}
                    record={item}
                    trigger={
                      <button type="button" className={linkButton}>
                        Rename
                      </button>
                    }
                    onSubmit={(patch) => update.mutateAsync({ id: item.id, patch })}
                  />
                </PermissionGate>
              </div>
            </div>
          )
        }}
      />
    </section>
  )
}
