import { describeEvidenceVersion } from './evidence-form.ts'
import { useEvidenceVersion } from './evidence.queries.ts'

// The human-readable name of one exact evidence version, read by its immutable id. Without evidence read
// permission it says "Unavailable", never the raw id.
export function EvidenceVersionLabel({ versionId }: { versionId: string }) {
  const version = useEvidenceVersion(versionId)
  if (!version.permitted || version.isError) return <>Unavailable</>
  return <>{version.data ? describeEvidenceVersion(version.data) : 'Loading...'}</>
}
