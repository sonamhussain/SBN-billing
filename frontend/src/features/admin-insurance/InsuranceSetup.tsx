import { SimpleMasterSection, type MasterRecord } from '../admin/SimpleMasterSection.tsx'
import { InsuranceProducts } from './InsuranceProducts.tsx'

// FE-05 — the insurance masters: Payers, TPAs and Networks (display name only) and Insurance products with
// their networks. Nothing here checks eligibility or talks to a payer.

type NamedMaster = MasterRecord & { displayName: string }

const nameField = [{ key: 'displayName', label: 'Display name', required: true }]

export function InsuranceSetup() {
  return (
    <div className="space-y-10">
      <SimpleMasterSection<NamedMaster>
        title="Payers"
        noun="payers"
        subject="Payer"
        owner={{ collection: 'payers', read: 'payer.read', create: 'payer.create', update: 'payer.update' }}
        fields={nameField}
        primary={(item) => item.displayName}
      />
      <SimpleMasterSection<NamedMaster>
        title="TPAs"
        noun="TPAs"
        subject="TPA"
        owner={{ collection: 'tpas', read: 'tpa.read', create: 'tpa.create', update: 'tpa.update' }}
        fields={nameField}
        primary={(item) => item.displayName}
      />
      <SimpleMasterSection<NamedMaster>
        title="Networks"
        noun="networks"
        subject="Network"
        owner={{ collection: 'networks', read: 'network.read', create: 'network.create', update: 'network.update' }}
        fields={nameField}
        primary={(item) => item.displayName}
      />
      <InsuranceProducts />
    </div>
  )
}
