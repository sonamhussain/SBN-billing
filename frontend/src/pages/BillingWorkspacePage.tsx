import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { AuthorizationSection } from '../features/authorization/AuthorizationSection.tsx'
import { CommercialContextSummary } from '../features/commercial-context/CommercialContextSummary.tsx'
import { EligibilitySection } from '../features/eligibility/EligibilitySection.tsx'
import { useEncounter } from '../features/encounter/encounter.queries.ts'
import type { Encounter } from '../features/encounter/encounter.types.ts'
import { BillingContextSummary } from '../features/encounter-context/BillingContextSummary.tsx'
import { isContextConflict } from '../features/encounter-context/context-conflict.ts'
import { useEncounterBillingContext } from '../features/encounter-context/encounter-context.queries.ts'
import { EvidenceSection } from '../features/evidence/EvidenceSection.tsx'
import { ReadinessSection } from '../features/readiness/ReadinessSection.tsx'
import { ValidationSection } from '../features/validation/ValidationSection.tsx'
import { usePermission } from '../shared/auth/usePermission.ts'
import { formatDateOnly } from '../shared/format/date.ts'
import { PageHeader } from '../shared/layout/PageHeader.tsx'
import { RecordSection } from '../shared/ui/RecordSection.tsx'
import { Skeleton } from '../shared/ui/Skeleton.tsx'

// FE-04 — the permanent Billing Lifecycle Workspace for one Encounter: context, coverage & authorization,
// evidence, commercial context, validation and readiness, as sections. It presents the A5 pre-claim
// history and offers only explicit, permission-gated actions owned by the backend. It never submits,
// approves, prices or creates a claim. Future A6–A8 sections extend this page.

function BillingWorkspace({ encounter }: { encounter: Encounter }) {
  const { can } = usePermission()
  const contextReadable = can('encounterBillingContext.read')
  const context = useEncounterBillingContext(encounter.id, contextReadable)
  // An incoherent stored context disables the actions that depend on it; history stays readable.
  const blocked = isContextConflict(context.error)

  return (
    <>
      <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
        <Link to={`/app/encounters/${encounter.id}`} className="inline-flex items-center gap-1.5 hover:text-slate-950">
          <ArrowLeft aria-hidden="true" size={15} /> Encounter
        </Link>
      </nav>

      <PageHeader eyebrow="Billing review" title={`Billing review — ${formatDateOnly(encounter.serviceDate)}`} />

      <BillingContextSummary context={context} readable={contextReadable} />

      <RecordSection title="Coverage & authorization" description="Recorded eligibility results and prior authorization history.">
        <div className="space-y-8">
          <EligibilitySection encounterId={encounter.id} readable={can('eligibilityVerification.read')} blocked={blocked} />
          <AuthorizationSection encounterId={encounter.id} readable={can('priorAuthorization.read')} blocked={blocked} />
        </div>
      </RecordSection>

      <EvidenceSection encounterId={encounter.id} blocked={blocked} />

      <CommercialContextSummary encounterId={encounter.id} readable={can('preClaimCommercialContext.read')} />

      <ValidationSection encounterId={encounter.id} blocked={blocked} />

      <ReadinessSection encounterId={encounter.id} />
    </>
  )
}

export default function BillingWorkspacePage() {
  const { encounterId = '' } = useParams()
  const encounter = useEncounter(encounterId)

  if (encounter.isPending) return <Skeleton className="h-40 w-full" />
  if (!encounter.data) {
    return (
      <>
        <nav aria-label="Back" className="mb-4 text-sm text-slate-500">
          <Link to="/app/billing" className="inline-flex items-center gap-1.5 hover:text-slate-950">
            <ArrowLeft aria-hidden="true" size={15} /> Billing
          </Link>
        </nav>
        <p role="alert" className="text-sm text-red-700">
          This encounter record is unavailable.
        </p>
      </>
    )
  }

  // Every A5 section mounts only once the Encounter itself is accessible, so a missing or foreign
  // Encounter never triggers an evidence, eligibility, authorization, validation or readiness request.
  return <BillingWorkspace key={encounter.data.id} encounter={encounter.data} />
}
