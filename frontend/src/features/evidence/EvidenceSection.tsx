import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { usePermission } from '../../shared/auth/usePermission.ts'
import { Button } from '../../shared/ui/Button.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { RecordSection } from '../../shared/ui/RecordSection.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { EvidenceCompletenessSummary } from '../evidence-completeness/EvidenceCompletenessSummary.tsx'
import { EncounterEvidenceLinks } from './EncounterEvidenceLinks.tsx'
import { useEncounterEvidenceLinks } from './evidence.queries.ts'
import { EvidenceLinkDialog } from './EvidenceLinkDialog.tsx'
import { EvidenceRegisterDialog } from './EvidenceRegisterDialog.tsx'

// FE-04 — Evidence: register evidence metadata, link exact versions to this Encounter, and evaluate
// requirement completeness. Every action is explicit and permission-gated; there is no upload.

const secondaryButton = 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'

export function EvidenceSection({ encounterId, blocked }: { encounterId: string; blocked: boolean }) {
  const { can } = usePermission()
  const links = useEncounterEvidenceLinks(encounterId, can('encounterEvidence.read'))

  return (
    <RecordSection
      title="Evidence"
      description="Evidence metadata recorded from documents held elsewhere, linked to this encounter by exact version."
      action={
        <div className="flex flex-wrap justify-end gap-2">
          <PermissionGate permission="evidenceArtifact.create">
            <EvidenceRegisterDialog trigger={<Button className={secondaryButton}>Register evidence</Button>} />
          </PermissionGate>
          <PermissionGate permission="encounterEvidence.create">
            <EvidenceLinkDialog encounterId={encounterId} trigger={<Button className={secondaryButton}>Link evidence</Button>} />
          </PermissionGate>
        </div>
      }
    >
      <div className="space-y-4">
        <PermissionGate permission="encounterEvidence.read" fallback={<EmptyState title="Encounter evidence links are not available to you." />}>
          {links.isPending && <Skeleton className="h-16 w-full" />}
          {links.isError && !links.data && (
            <p role="alert" className="text-sm text-red-700">
              Evidence links could not be loaded.
            </p>
          )}
          {links.data && <EncounterEvidenceLinks encounterId={encounterId} items={links.data} />}
        </PermissionGate>
        <EvidenceCompletenessSummary encounterId={encounterId} blocked={blocked} />
      </div>
    </RecordSection>
  )
}
