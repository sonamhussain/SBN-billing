import { readApiError } from '../../shared/api-error.ts'

export type ReferenceDataset = {
  id: string
  datasetKey: string
  displayName: string
  jurisdictionCode: string
  authorityCode: string
}

export type ReferenceDatasetVersion = {
  id: string
  datasetId: string
  version: string
  validationStatus: string
  activationStatus: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function loadReferenceDatasets(): Promise<ReferenceDataset[]> {
  const data = await handle<{ items: ReferenceDataset[] }>(await fetch('/api/reference-datasets'))
  return data.items
}

export async function loadReferenceDatasetVersions(datasetId: string): Promise<ReferenceDatasetVersion[]> {
  const data = await handle<{ items: ReferenceDatasetVersion[] }>(await fetch(`/api/reference-datasets/${datasetId}/versions`))
  return data.items
}
