import { useState } from 'react'
import { useOrganization } from '../../../shared/organization/useOrganization.ts'
import { Badge } from '../../../shared/ui/Badge.tsx'
import { Sheet } from '../../../shared/ui/Sheet.tsx'
import { Skeleton } from '../../../shared/ui/Skeleton.tsx'
import { SimpleMasterSection, type MasterRecord } from '../../admin/SimpleMasterSection.tsx'
import { useOwnerItems } from '../../admin/owner-query.ts'
import { GovernedDimensions } from '../GovernedDimensions.tsx'
import { SourceVersions } from './SourceVersions.tsx'

// FE-05 — Rule sources (A3.1) the owner lists for this organization. Should the owner ever return a
// system-shared source, it is marked and kept read-only — its identity, versions and lifecycle are not
// managed from an organization.
// An organization source's identity fields can be edited only until it has versions (the owner enforces it).
// Each source opens its versions and, as advanced detail, its recorded scopes.

const sourceCategories = [
  'REGULATORY_AUTHORITY',
  'CLAIMS_STANDARD',
  'TARIFF',
  'PROVIDER_CONTRACT',
  'PAYER_POLICY',
  'TPA_POLICY',
  'CLINICAL_STANDARD',
  'RESEARCH_PUBLICATION',
  'OPERATIONAL_GUIDANCE',
  'OTHER',
] as const

type RuleSource = MasterRecord & {
  organizationId: string | null
  jurisdictionCode: string
  issuingAuthority: string
  sourceCategory: string
  referenceNumber: string
  title: string
  ownershipScope: string
}
type Scope = { id: string } & Record<string, unknown>

function SourceScopes({ sourceId }: { sourceId: string }) {
  const scopes = useOwnerItems<Scope>(`/api/rule-sources/${sourceId}/scopes`, 'rule_source_scope.read')
  return (
    <details>
      <summary className="cursor-pointer text-sm text-[var(--sbn-accent)]">Scopes (advanced, read-only)</summary>
      <div className="mt-2 space-y-2">
        {!scopes.permitted && <p className="text-xs text-slate-500">Scopes are not available to you.</p>}
        {scopes.permitted && scopes.isPending && <Skeleton className="h-6 w-full" />}
        {scopes.isError && <p className="text-xs text-red-700">Scopes could not be loaded.</p>}
        {scopes.data &&
          (scopes.data.length === 0 ? (
            <p className="text-xs text-slate-500">No scope recorded.</p>
          ) : (
            <ul className="space-y-2">
              {scopes.data.map((scope) => (
                <li key={scope.id} className="rounded-md border border-slate-200 bg-white p-2">
                  <GovernedDimensions record={scope} />
                </li>
              ))}
            </ul>
          ))}
      </div>
    </details>
  )
}

function SourceSheet({ source, writable }: { source: RuleSource; writable: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      title={source.title}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100">
          Versions
        </button>
      }
    >
      <p className="mb-4 text-sm text-slate-500">
        {source.referenceNumber} · {source.sourceCategory} · {source.jurisdictionCode} · {source.issuingAuthority}
        {!writable && ' · system-shared (read-only)'}
      </p>
      {open && (
        <div className="space-y-6">
          <SourceVersions sourceId={source.id} jurisdictionCode={source.jurisdictionCode} writable={writable} />
          <SourceScopes sourceId={source.id} />
        </div>
      )}
    </Sheet>
  )
}

export function RuleSources() {
  const { organizationId } = useOrganization()
  const ownedHere = (source: RuleSource) => source.organizationId === organizationId

  return (
    <div className="space-y-3">
      <SimpleMasterSection<RuleSource>
        title="Rule sources"
        noun="rule sources"
        subject="Rule source"
        owner={{ collection: 'rule-sources', read: 'rule_source.read', create: 'rule_source.create', update: 'rule_source.update' }}
        fields={[
          { key: 'title', label: 'Title', required: true },
          { key: 'referenceNumber', label: 'Reference number', required: true },
          { key: 'sourceCategory', label: 'Source category', required: true, options: sourceCategories },
          { key: 'issuingAuthority', label: 'Issuing authority', required: true },
          { key: 'jurisdictionCode', label: 'Jurisdiction code', required: true },
        ]}
        primary={(item) => `${item.referenceNumber} — ${item.title}`}
        secondary={(item) => `${item.sourceCategory} · ${item.jurisdictionCode} · ${item.issuingAuthority}`}
        badge={(item) => (ownedHere(item) ? null : <Badge>System</Badge>)}
        editable={ownedHere}
        detail={(item) => <SourceSheet source={item} writable={ownedHere(item)} />}
      />
      <p className="text-xs text-slate-500">
        Publication, verification and activation are recorded per version through the owner's lifecycle actions. Each version's recorded state is shown
        as stored; this workspace never decides which version is current.
      </p>
    </div>
  )
}
