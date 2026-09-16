import { useState } from 'react'
import { loadReferenceDatasetVersions, loadReferenceDatasets, type ReferenceDataset, type ReferenceDatasetVersion } from './reference-dataset.api.ts'

export default function ReferenceDatasetCheck() {
  const [datasets, setDatasets] = useState<ReferenceDataset[] | null>(null)
  const [versionsByDataset, setVersionsByDataset] = useState<Record<string, ReferenceDatasetVersion[]>>({})
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleLoad() {
    setLoading(true)
    setError('')
    try {
      const items = await loadReferenceDatasets()
      setDatasets(items)
      const entries = await Promise.all(items.map(async (d) => [d.id, await loadReferenceDatasetVersions(d.id)] as const))
      setVersionsByDataset(Object.fromEntries(entries))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Reference Dataset Check (REF-01 / R3)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Read-only. SYSTEM_SHARED registry — no tenant mutation UI. Import/validate/activate/retire happen only via the internal
        maintenance module.
      </p>

      <button className="mt-4 rounded-md bg-slate-700 px-4 py-2 text-white disabled:opacity-50" disabled={loading} type="button" onClick={handleLoad}>
        {loading ? 'Loading...' : 'Load Datasets'}
      </button>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      {datasets && datasets.length === 0 && <p className="mt-3 text-sm text-slate-600">No reference datasets yet.</p>}

      {datasets && datasets.length > 0 && (
        <div className="mt-4 space-y-2">
          {datasets.map((dataset) => (
            <div key={dataset.id} className="rounded-md bg-slate-100 p-3 text-sm">
              <p className="font-medium">
                {dataset.datasetKey} — {dataset.displayName} ({dataset.jurisdictionCode}/{dataset.authorityCode})
              </p>
              {(versionsByDataset[dataset.id] ?? []).map((version) => (
                <p key={version.id} className="ml-3 text-slate-600">
                  v{version.version} — validation={version.validationStatus} activation={version.activationStatus}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
