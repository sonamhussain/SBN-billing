import { useState } from 'react'
import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { formatDateOnly, formatInstant } from '../../shared/format/date.ts'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { RemoveConfirm } from '../encounter/RemoveConfirm.tsx'
import { describeEvidenceVersion } from './evidence-form.ts'
import { useEvidenceLinkMutations, useEvidenceVersion } from './evidence.queries.ts'
import type { EncounterEvidenceLink } from './evidence.types.ts'
import { EvidenceVersionDialog } from './EvidenceVersionDialog.tsx'

// FE-04 — the Encounter's active evidence links (A5.6), each naming the exact linked version. The opaque
// storage reference and content hash appear only when the user opens a link's details. There is no
// preview or download: no content route exists. Removal is the one-way owner route.

function LinkRow({ link, onRemove }: { link: EncounterEvidenceLink; onRemove: () => Promise<unknown> }) {
  const version = useEvidenceVersion(link.evidenceArtifactVersionId)
  const [open, setOpen] = useState(false)
  const label = !version.permitted || version.isError ? 'Evidence metadata unavailable' : version.data ? describeEvidenceVersion(version.data) : 'Loading...'

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-slate-950">{label}</p>
          <p className="mt-0.5 text-xs text-slate-500">Linked {formatInstant(link.createdAt)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {version.data && (
            <button
              type="button"
              aria-expanded={open}
              className="rounded px-1.5 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100"
              onClick={() => setOpen(!open)}
            >
              {open ? 'Hide details' : 'Details'}
            </button>
          )}
          {version.data && (
            <PermissionGate permission="evidenceArtifactVersion.create">
              <EvidenceVersionDialog
                artifactId={version.data.evidenceArtifactId}
                trigger={
                  <button type="button" className="rounded px-1.5 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100">
                    Add version
                  </button>
                }
              />
            </PermissionGate>
          )}
          <PermissionGate permission="encounterEvidence.update">
            <RemoveConfirm
              subject="evidence link"
              description="This evidence version will no longer be linked to the encounter. The evidence itself and the link's history are kept."
              onConfirm={onRemove}
            />
          </PermissionGate>
        </div>
      </div>
      {open && version.data && (
        <dl className="mt-3 grid gap-x-6 gap-y-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2">
          <DetailItem label="Document type" value={version.data.documentType} />
          <DetailItem label="Version" value={`v${version.data.version}`} />
          <DetailItem label="Received at" value={formatInstant(version.data.receivedAt)} />
          <DetailItem label="Source date" value={version.data.sourceDate ? formatDateOnly(version.data.sourceDate) : null} />
          <DetailItem label="Storage reference" value={<span className="break-all font-mono text-xs">{version.data.storageRef}</span>} />
          <DetailItem label="Content hash (SHA-256)" value={<span className="break-all font-mono text-xs">{version.data.contentHash}</span>} />
        </dl>
      )}
    </li>
  )
}

export function EncounterEvidenceLinks({ encounterId, items }: { encounterId: string; items: EncounterEvidenceLink[] }) {
  const { remove } = useEvidenceLinkMutations(encounterId)
  if (items.length === 0) return <EmptyState title="No evidence linked to this encounter" />
  return (
    <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
      {items.map((link) => (
        <LinkRow key={link.id} link={link} onRemove={() => remove.mutateAsync(link.id)} />
      ))}
    </ul>
  )
}
