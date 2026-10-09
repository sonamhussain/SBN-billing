import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { apiRequest } from '../../shared/api/client.ts'
import { describeSaveError } from '../../shared/api/error-message.ts'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
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
import { LoadedList } from '../admin/LoadedList.tsx'
import { MasterFormDialog } from '../admin/MasterFormDialog.tsx'
import { useMasterList, useMasterMutations, type MasterOwner } from '../admin/master-api.ts'
import { ownerKey, useOwnerItems } from '../admin/owner-query.ts'

// FE-05 — Insurance products (REF-01): a product belongs to one payer chosen by name, has a product code and
// a display name (only the name is editable after creation). A product's networks are child records added
// one at a time through the owner route; nothing is inferred between payers and networks.

type Named = { id: string; displayName: string }
type InsuranceProduct = { id: string; payerId: string; productCode: string; displayName: string }
type ProductNetwork = { id: string; insuranceProductId: string; networkId: string; createdAt: string }

const productOwner: MasterOwner = {
  collection: 'insurance-products',
  read: 'insurance_product.read',
  create: 'insurance_product.create',
  update: 'insurance_product.update',
}
const payerOwner: MasterOwner = { collection: 'payers', read: 'payer.read', create: 'payer.create', update: 'payer.update' }
const networkOwner: MasterOwner = { collection: 'networks', read: 'network.read', create: 'network.create', update: 'network.update' }

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'
const linkButton = 'rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100'

function CreateProductDialog() {
  const { organizationId } = useOrganization()
  const payers = useMasterList<Named>(payerOwner, organizationId)
  const { create } = useMasterMutations<InsuranceProduct>(productOwner, organizationId)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ payerId: '', productCode: '', displayName: '' })

  function onOpenChange(next: boolean) {
    setOpen(next)
    setDraft({ payerId: '', productCode: '', displayName: '' })
    create.reset()
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await create.mutateAsync(draft)
      onOpenChange(false)
    } catch {
      // Shown below from the mutation state.
    }
  }

  return (
    <Dialog title="New insurance product" open={open} onOpenChange={onOpenChange} trigger={<Button className={secondaryButton}>New insurance product</Button>}>
      <form className="space-y-3" onSubmit={submit}>
        {create.isError && <Alert tone="danger">{describeSaveError(create.error, 'Insurance product')}</Alert>}
        <OptionPicker
          label="Payer"
          required
          value={draft.payerId}
          onChange={(payerId) => setDraft({ ...draft, payerId })}
          options={payers.data?.map((payer) => ({ value: payer.id, label: payer.displayName }))}
          placeholder="Select a payer"
          loading={payers.isPending && payers.permitted}
          unavailable={!payers.permitted || payers.isError}
        />
        <Field label="Product code">
          <Input required autoComplete="off" value={draft.productCode} onChange={(e) => setDraft({ ...draft, productCode: e.target.value })} />
        </Field>
        <Field label="Display name">
          <Input required autoComplete="off" value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending || draft.payerId === ''}>
            {create.isPending ? 'Saving...' : 'Create insurance product'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function AddNetworkDialog({ productId }: { productId: string }) {
  const { organizationId } = useOrganization()
  const client = useQueryClient()
  const networks = useMasterList<Named>(networkOwner, organizationId)
  const [open, setOpen] = useState(false)
  const [networkId, setNetworkId] = useState('')
  const add = useMutation({
    mutationFn: () =>
      apiRequest<ProductNetwork>(`/api/insurance-products/${productId}/product-networks`, { method: 'POST', body: JSON.stringify({ networkId }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ownerKey(`/api/insurance-products/${productId}/product-networks`) }),
  })

  function onOpenChange(next: boolean) {
    setOpen(next)
    setNetworkId('')
    add.reset()
  }

  return (
    <Dialog title="Add network to product" open={open} onOpenChange={onOpenChange} trigger={<Button className={secondaryButton}>Add network</Button>}>
      <form
        className="space-y-3"
        onSubmit={async (event) => {
          event.preventDefault()
          try {
            await add.mutateAsync()
            onOpenChange(false)
          } catch {
            // Shown below from the mutation state.
          }
        }}
      >
        {add.isError && <Alert tone="danger">{describeSaveError(add.error, 'Product network')}</Alert>}
        <OptionPicker
          label="Network"
          required
          value={networkId}
          onChange={setNetworkId}
          options={networks.data?.map((network) => ({ value: network.id, label: network.displayName }))}
          placeholder="Select a network"
          loading={networks.isPending && networks.permitted}
          unavailable={!networks.permitted || networks.isError}
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={add.isPending || networkId === ''}>
            {add.isPending ? 'Saving...' : 'Add network'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function ProductNetworks({ product, networkName }: { product: InsuranceProduct; networkName: (id: string) => string }) {
  const links = useOwnerItems<ProductNetwork>(`/api/insurance-products/${product.id}/product-networks`, 'product_network.read')
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-950">Networks</h3>
        <PermissionGate permission="product_network.create">
          <AddNetworkDialog productId={product.id} />
        </PermissionGate>
      </div>
      {!links.permitted && <EmptyState title="Product networks are not available to you." />}
      {links.permitted && links.isPending && <Skeleton className="h-12 w-full" />}
      {links.isError && <p className="text-sm text-red-700">Product networks could not be loaded.</p>}
      {links.data &&
        (links.data.length === 0 ? (
          <EmptyState title="No network recorded for this product" />
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white text-sm">
            {links.data.map((link) => (
              <li key={link.id} className="px-3 py-2">
                {networkName(link.networkId)}
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

function ProductSheet({ product, payerName, networkName }: { product: InsuranceProduct; payerName: string; networkName: (id: string) => string }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      title={product.displayName}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className={linkButton}>
          Networks
        </button>
      }
    >
      <p className="mb-4 text-sm text-slate-500">
        {payerName} · product code {product.productCode}
      </p>
      {open && <ProductNetworks product={product} networkName={networkName} />}
    </Sheet>
  )
}

export function InsuranceProducts() {
  const { organizationId } = useOrganization()
  const products = useMasterList<InsuranceProduct>(productOwner, organizationId)
  const payers = useMasterList<Named>(payerOwner, organizationId)
  const networks = useMasterList<Named>(networkOwner, organizationId)
  const { update } = useMasterMutations<InsuranceProduct>(productOwner, organizationId)
  const labelFrom = (query: { data: Named[] | undefined; permitted: boolean; isPending: boolean }) => (id: string) =>
    !query.permitted ? 'Unavailable' : query.isPending ? 'Loading...' : (query.data?.find((item) => item.id === id)?.displayName ?? 'Unavailable')
  const payerName = labelFrom(payers)
  const networkName = labelFrom(networks)

  return (
    <section aria-label="Insurance products" className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-base font-semibold text-slate-950">Insurance products</h3>
        <PermissionGate permission={productOwner.create}>
          <CreateProductDialog />
        </PermissionGate>
      </div>
      <LoadedList
        noun="insurance products"
        query={products}
        rowKey={(item) => item.id}
        filterText={(item) => `${item.productCode} ${item.displayName} ${payerName(item.payerId)}`}
        emptyTitle="No insurance products recorded"
        renderRow={(item) => (
          <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-950">
                {item.productCode} — {item.displayName}
              </p>
              <p className="truncate text-xs text-slate-500">{payerName(item.payerId)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <ProductSheet product={item} payerName={payerName(item.payerId)} networkName={networkName} />
              <PermissionGate permission={productOwner.update}>
                <MasterFormDialog
                  title="Edit insurance product"
                  subject="Insurance product"
                  fields={[{ key: 'displayName', label: 'Display name', required: true }]}
                  record={item}
                  trigger={
                    <button type="button" className={linkButton}>
                      Edit
                    </button>
                  }
                  onSubmit={(patch) => update.mutateAsync({ id: item.id, patch })}
                />
              </PermissionGate>
            </div>
          </div>
        )}
      />
    </section>
  )
}
