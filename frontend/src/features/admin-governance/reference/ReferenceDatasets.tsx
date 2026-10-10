import { useState } from 'react'
import { formatDateOnly, formatInstant } from '../../../shared/format/date.ts'
import { EmptyState } from '../../../shared/ui/EmptyState.tsx'
import { OutcomeBadge } from '../../../shared/ui/OutcomeBadge.tsx'
import { Skeleton } from '../../../shared/ui/Skeleton.tsx'
import { LoadedList } from '../../admin/LoadedList.tsx'
import { useOwnerItems } from '../../admin/owner-query.ts'

// FE-05 — Regulatory and reference data. Reference datasets (REF-01) are system-shared and read-only: the
// owner offers no write route to an organization, so their versions and recorded validation/activation are
// only shown. Facility regulatory profiles need a known facility: they are shown under a clinician's
// recorded facility assignments in Setup, because no complete facility collection exists.

type Dataset = { id: string; datasetKey: string; displayName: string; jurisdictionCode: string; authorityCode: string }
type DatasetVersion = {
  id: string
  version: string
  retrievedAt: string
  publicationDate: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  contentHash: string
  validationStatus: string
  activationStatus: string
}

// A period with neither end recorded reads as one "Not recorded" rather than two placeholders.
const period = (from: string | null, to: string | null) =>
  !from && !to ? 'Not recorded' : `${formatDateOnly(from)} – ${to ? formatDateOnly(to) : 'no end recorded'}`

function DatasetVersions({ datasetId }: { datasetId: string }) {
  const versions = useOwnerItems<DatasetVersion>(`/api/reference-datasets/${datasetId}/versions`, null)
  if (versions.isPending) return <Skeleton className="h-8 w-full" />
  if (versions.isError) return <p className="text-xs text-red-700">Dataset versions could not be loaded.</p>
  if (versions.data.length === 0) return <p className="text-xs text-slate-500">No version recorded.</p>
  return (
    <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
      {versions.data.map((version) => (
        <li key={version.id} className="space-y-1 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-950">Version {version.version}</span>
            <OutcomeBadge value={version.validationStatus} />
            <OutcomeBadge value={version.activationStatus} />
          </div>
          <p className="text-slate-500">
            Effective {period(version.effectiveFrom, version.effectiveTo)} · published {formatDateOnly(version.publicationDate)} · retrieved{' '}
            {formatInstant(version.retrievedAt)}
          </p>
          <p className="break-all font-mono text-slate-400">{version.contentHash}</p>
        </li>
      ))}
    </ul>
  )
}

export function ReferenceDatasets() {
  // Reference datasets are system-shared; the owner requires only a signed-in session to read them.
  const datasets = useOwnerItems<Dataset>('/api/reference-datasets', null)
  const [openId, setOpenId] = useState('')
  return (
    <div className="space-y-8">
      <section aria-label="Reference datasets" className="space-y-3">
        <h3 className="text-base font-semibold text-slate-950">Reference datasets</h3>
        <p className="text-xs text-slate-500">System-shared reference data, read-only. Versions are listed as recorded; none is chosen as current here.</p>
        <LoadedList
          noun="reference datasets"
          query={{ ...datasets, permitted: true }}
          rowKey={(item) => item.id}
          filterText={(item) => `${item.datasetKey} ${item.displayName} ${item.jurisdictionCode} ${item.authorityCode}`}
          emptyTitle="No reference datasets recorded"
          renderRow={(item) => (
            <div className="space-y-2 px-4 py-2.5 text-sm">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-950">
                    {item.datasetKey} — {item.displayName}
                  </p>
                  <p className="truncate text-xs text-slate-500">
                    {item.jurisdictionCode} · {item.authorityCode}
                  </p>
                </div>
                <button
                  type="button"
                  aria-expanded={openId === item.id}
                  className="shrink-0 rounded px-2 py-1 text-sm text-[var(--sbn-accent)] hover:bg-slate-100"
                  onClick={() => setOpenId(openId === item.id ? '' : item.id)}
                >
                  {openId === item.id ? 'Hide versions' : 'Versions'}
                </button>
              </div>
              {openId === item.id && <DatasetVersions datasetId={item.id} />}
            </div>
          )}
        />
      </section>
      <section aria-label="Facility regulatory profiles" className="space-y-2">
        <h3 className="text-base font-semibold text-slate-950">Facility regulatory profiles</h3>
        <EmptyState
          title="Shown where a facility is already known"
          message="Regulatory profiles belong to a facility. Until a complete facility collection exists, they are shown read-only under a clinician's recorded facility assignments in Setup → Clinical."
        />
      </section>
    </div>
  )
}
