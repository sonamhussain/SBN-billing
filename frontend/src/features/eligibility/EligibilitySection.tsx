import { PermissionGate } from '../../shared/auth/PermissionGate.tsx'
import { formatInstant } from '../../shared/format/date.ts'
import { Button } from '../../shared/ui/Button.tsx'
import { EmptyState } from '../../shared/ui/EmptyState.tsx'
import { OutcomeBadge } from '../../shared/ui/OutcomeBadge.tsx'
import { Skeleton } from '../../shared/ui/Skeleton.tsx'
import { EvidenceVersionLabel } from '../evidence/EvidenceVersionLabel.tsx'
import { EligibilityRecordDialog } from './EligibilityRecordDialog.tsx'
import { useEligibilityVerifications } from './eligibility.queries.ts'
import type { EligibilityVerification } from './eligibility.types.ts'

// FE-04 — Coverage verification: the immutable history of recorded eligibility results, in the backend's
// order. Reported status and server-derived freshness are separate columns; no row is labelled current,
// best or primary. This is different from FE-02 "Recorded coverage", which is membership registration.

const yesNo = (value: boolean | null) => (value === null ? 'Not recorded' : value ? 'Yes' : 'No')

function VerificationRow({ verification }: { verification: EligibilityVerification }) {
  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-500">Status</span>
        <OutcomeBadge value={verification.status} />
        <span className="ml-2 text-slate-500">Freshness</span>
        <OutcomeBadge value={verification.freshness.state} />
        <span className="ml-auto text-xs text-slate-500">{verification.verificationMethod}</span>
      </div>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
        <div>
          <dt className="inline text-slate-500">Responded </dt>
          <dd className="inline">{formatInstant(verification.respondedAt)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Valid through </dt>
          <dd className="inline">{formatInstant(verification.validThrough)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Authorization required </dt>
          <dd className="inline">{yesNo(verification.authorizationRequired)}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Referral required </dt>
          <dd className="inline">{yesNo(verification.referralRequired)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline text-slate-500">Response evidence </dt>
          <dd className="inline">
            <EvidenceVersionLabel versionId={verification.responseEvidenceVersionId} />
          </dd>
        </div>
      </dl>
    </li>
  )
}

export function EligibilitySection({ encounterId, readable, blocked }: { encounterId: string; readable: boolean; blocked: boolean }) {
  const verifications = useEligibilityVerifications(encounterId, readable)

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">Coverage verification</h3>
          <p className="mt-0.5 text-xs text-slate-500">Recorded eligibility results. Fresh does not mean eligible; no record is treated as current.</p>
        </div>
        <PermissionGate permission="eligibilityVerification.create">
          <EligibilityRecordDialog
            encounterId={encounterId}
            trigger={
              <Button className="border border-slate-300 bg-white text-slate-800 hover:bg-slate-50" disabled={blocked}>
                Record verification
              </Button>
            }
          />
        </PermissionGate>
      </div>
      {!readable && <EmptyState title="Coverage verification history is not available to you." />}
      {readable && verifications.isPending && <Skeleton className="h-16 w-full" />}
      {verifications.isError && !verifications.data && (
        <p role="alert" className="text-sm text-red-700">
          Coverage verification history could not be loaded.
        </p>
      )}
      {verifications.data &&
        (verifications.data.length === 0 ? (
          <EmptyState title="No verification recorded" />
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white">
            {verifications.data.map((verification) => (
              <VerificationRow key={verification.id} verification={verification} />
            ))}
          </ul>
        ))}
    </div>
  )
}
