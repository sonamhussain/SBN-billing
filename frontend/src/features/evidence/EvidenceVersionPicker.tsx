import { useId, useState } from 'react'
import { useOrganization } from '../../shared/organization/useOrganization.ts'
import { Select } from '../../shared/ui/Select.tsx'
import { OptionPicker } from '../encounter-lookups/OptionPicker.tsx'
import { describeEvidenceArtifact, describeEvidenceVersion } from './evidence-form.ts'
import { useEvidenceVersions, useOrganizationEvidence } from './evidence.queries.ts'

// FE-04 — chooses one exact EvidenceArtifactVersion: first the registered evidence (filterable, from the
// organization's metadata), then its version — the latest by default, any earlier version by choice. Only
// the version id is passed on; nothing is uploaded or opened.
export function EvidenceVersionPicker({
  label,
  hint,
  value,
  onChange,
  required = false,
}: {
  label: string
  hint?: string
  value: string
  onChange: (versionId: string) => void
  required?: boolean
}) {
  const { organizationId } = useOrganization()
  const versionSelectId = useId()
  const evidence = useOrganizationEvidence(organizationId, true)
  const [artifactId, setArtifactId] = useState('')
  const versions = useEvidenceVersions(artifactId)

  function chooseArtifact(nextArtifactId: string) {
    setArtifactId(nextArtifactId)
    const artifact = evidence.data?.find((item) => item.id === nextArtifactId)
    onChange(artifact ? artifact.latestVersion.id : '')
  }

  return (
    <div className="space-y-2">
      <OptionPicker
        label={label}
        hint={hint}
        required={required}
        value={artifactId}
        onChange={chooseArtifact}
        options={evidence.data?.map((artifact) => ({
          value: artifact.id,
          label: describeEvidenceArtifact(artifact.latestVersion),
        }))}
        placeholder={required ? 'Select registered evidence' : 'Not recorded'}
        loading={evidence.isPending && evidence.permitted}
        unavailable={!evidence.permitted || evidence.isError}
      />
      {artifactId !== '' && (
        <div className="text-sm">
          <label htmlFor={versionSelectId} className="font-medium text-slate-700">
            Version
          </label>
          <Select id={versionSelectId} className="mt-1" required={required} value={value} onChange={(e) => onChange(e.target.value)} disabled={versions.isPending}>
            {versions.isPending && <option value={value}>Loading versions...</option>}
            {(versions.data ?? []).map((version) => (
              <option key={version.id} value={version.id}>
                {describeEvidenceVersion(version)}
              </option>
            ))}
          </Select>
          {versions.isError && <p className="mt-1 text-red-700">Versions could not be loaded; the latest version stays selected.</p>}
        </div>
      )}
    </div>
  )
}
