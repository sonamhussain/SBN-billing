import { useState } from 'react'
import { formatDateOnly, formatInstant } from '../../../shared/format/date.ts'
import { useOrganization } from '../../../shared/organization/useOrganization.ts'
import { Badge } from '../../../shared/ui/Badge.tsx'
import { EmptyState } from '../../../shared/ui/EmptyState.tsx'
import { OutcomeBadge } from '../../../shared/ui/OutcomeBadge.tsx'
import { Sheet } from '../../../shared/ui/Sheet.tsx'
import { Skeleton } from '../../../shared/ui/Skeleton.tsx'
import { LoadedList } from '../../admin/LoadedList.tsx'
import { useMasterList } from '../../admin/master-api.ts'
import { useOwnerItems, useOwnerRecord } from '../../admin/owner-query.ts'

// FE-05 — Rule packs (A3.9), read-first: each pack's versions with their recorded verification and
// activation, and each version's member rule versions. Packs are not composed, activated or edited here, and
// no provenance is reconstructed in the browser.

type RulePack = { id: string; organizationId: string | null; packKey: string; displayName: string; jurisdictionCode: string }
type PackVersion = {
  id: string
  version: string
  effectiveFrom: string | null
  effectiveTo: string | null
  verificationStatus: string
  verifiedAt: string | null
  activationStatus: string
  activatedAt: string | null
}
type Member = { id: string; ruleVersionId: string }

// A period with neither end recorded reads as one "Not recorded" rather than two placeholders.
const period = (from: string | null, to: string | null) =>
  !from && !to ? 'Not recorded' : `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function MemberLabel({ ruleVersionId }: { ruleVersionId: string }) {
  const version = useOwnerRecord<{ version: string; effectType: string; ruleId: string }>(`/api/rule-versions/${ruleVersionId}`, 'rule_version.read')
  const rule = useOwnerRecord<{ ruleKey: string }>(version.data ? `/api/rule-definitions/${version.data.ruleId}` : null, 'rule_definition.read')
  if (!version.permitted || version.isError) return <>Unavailable</>
  if (!version.data) return <>Loading...</>
  const ruleKey = !rule.permitted || rule.isError ? 'rule unavailable' : (rule.data?.ruleKey ?? 'Loading...')
  return (
    <>
      {ruleKey} · version {version.data.version} · <span className="font-mono">{version.data.effectType}</span>
    </>
  )
}

function VersionMembers({ versionId }: { versionId: string }) {
  const members = useOwnerItems<Member>(`/api/rule-pack-versions/${versionId}/members`, 'rule_pack.read')
  if (members.isPending) return <Skeleton className="h-6 w-full" />
  if (members.isError) return <p className="text-xs text-red-700">Members could not be loaded.</p>
  if (members.data.length === 0) return <p className="text-xs text-slate-500">No member recorded.</p>
  return (
    <ul className="space-y-0.5 text-xs text-slate-700">
      {members.data.map((member) => (
        <li key={member.id}>
          <MemberLabel ruleVersionId={member.ruleVersionId} />
        </li>
      ))}
    </ul>
  )
}

function PackVersions({ packId }: { packId: string }) {
  const versions = useOwnerItems<PackVersion>(`/api/rule-packs/${packId}/versions`, 'rule_pack.read')
  const [openId, setOpenId] = useState('')
  if (versions.isPending) return <Skeleton className="h-12 w-full" />
  if (versions.isError) return <p className="text-sm text-red-700">Pack versions could not be loaded.</p>
  if (versions.data.length === 0) return <EmptyState title="No version recorded for this pack" />
  return (
    <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
      {versions.data.map((version) => (
        <li key={version.id} className="space-y-2 px-3 py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-950">Version {version.version}</span>
            <OutcomeBadge value={version.verificationStatus} />
            <OutcomeBadge value={version.activationStatus} />
            <button
              type="button"
              aria-expanded={openId === version.id}
              className="ml-auto rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100"
              onClick={() => setOpenId(openId === version.id ? '' : version.id)}
            >
              {openId === version.id ? 'Hide members' : 'Members'}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            Effective {period(version.effectiveFrom, version.effectiveTo)}
            {version.verifiedAt ? ` · verified ${formatInstant(version.verifiedAt)}` : ''}
            {version.activatedAt ? ` · activated ${formatInstant(version.activatedAt)}` : ''}
          </p>
          {openId === version.id && (
            <div className="rounded-md bg-slate-50 p-2">
              <VersionMembers versionId={version.id} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function PackSheet({ pack, system }: { pack: RulePack; system: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Sheet
      title={pack.displayName}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100">
          Versions
        </button>
      }
    >
      <p className="mb-4 text-sm text-slate-500">
        {pack.packKey} · {pack.jurisdictionCode}
        {system && ' · system-shared'} · read-only
      </p>
      {open && <PackVersions packId={pack.id} />}
    </Sheet>
  )
}

export function RulePacks() {
  const { organizationId } = useOrganization()
  const packs = useMasterList<RulePack>({ collection: 'rule-packs', read: 'rule_pack.read', create: 'rule_pack.write', update: 'rule_pack.write' }, organizationId)
  return (
    <section aria-label="Rule packs" className="space-y-3">
      <h3 className="text-base font-semibold text-slate-950">Rule packs</h3>
      <p className="text-xs text-slate-500">Read-only history of rule packs, their versions and member rule versions.</p>
      <LoadedList
        noun="rule packs"
        query={packs}
        rowKey={(item) => item.id}
        filterText={(item) => `${item.packKey} ${item.displayName} ${item.jurisdictionCode}`}
        emptyTitle="No rule packs recorded"
        renderRow={(item) => (
          <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-medium text-slate-950">
                <span className="truncate">
                  {item.packKey} — {item.displayName}
                </span>
                {item.organizationId !== organizationId && <Badge>System</Badge>}
              </p>
              <p className="truncate text-xs text-slate-500">{item.jurisdictionCode}</p>
            </div>
            <PackSheet pack={item} system={item.organizationId !== organizationId} />
          </div>
        )}
      />
    </section>
  )
}
