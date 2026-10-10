import { useState } from 'react'
import { useOrganization } from '../../../shared/organization/useOrganization.ts'
import { Badge } from '../../../shared/ui/Badge.tsx'
import { Sheet } from '../../../shared/ui/Sheet.tsx'
import { SimpleMasterSection, type MasterRecord } from '../../admin/SimpleMasterSection.tsx'
import { RuleVersions } from './RuleVersions.tsx'

// FE-05 — Rule definitions (A3.5): a rule's key and jurisdiction are fixed at creation; only its display name
// can be edited. System-shared rules are read-only here. Each rule opens its version history.

type RuleDefinition = MasterRecord & {
  organizationId: string | null
  ruleKey: string
  displayName: string
  jurisdictionCode: string
  ownershipScope: string
}

function RuleSheet({ rule, writable }: { rule: RuleDefinition; writable: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      title={rule.displayName}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100">
          Versions
        </button>
      }
    >
      <p className="mb-4 text-sm text-slate-500">
        {rule.ruleKey} · {rule.jurisdictionCode}
        {!writable && ' · system-shared (read-only)'}
      </p>
      {open && <RuleVersions ruleId={rule.id} writable={writable} />}
    </Sheet>
  )
}

export function RuleDefinitions() {
  const { organizationId } = useOrganization()
  const ownedHere = (rule: RuleDefinition) => rule.organizationId === organizationId

  return (
    <SimpleMasterSection<RuleDefinition>
      title="Rule definitions"
      noun="rule definitions"
      subject="Rule definition"
      owner={{ collection: 'rule-definitions', read: 'rule_definition.read', create: 'rule_definition.create', update: 'rule_definition.update' }}
      fields={[
        { key: 'ruleKey', label: 'Rule key', required: true },
        { key: 'displayName', label: 'Display name', required: true },
        { key: 'jurisdictionCode', label: 'Jurisdiction code', required: true },
      ]}
      editFields={[{ key: 'displayName', label: 'Display name', required: true }]}
      primary={(item) => `${item.ruleKey} — ${item.displayName}`}
      secondary={(item) => item.jurisdictionCode}
      badge={(item) => (ownedHere(item) ? null : <Badge>System</Badge>)}
      editable={ownedHere}
      detail={(item) => <RuleSheet rule={item} writable={ownedHere(item)} />}
    />
  )
}
