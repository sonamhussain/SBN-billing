import { formatDateOnly } from '../../shared/format/date.ts'
import { DetailItem } from '../../shared/ui/DetailItem.tsx'
import type { Patient } from './patient.types.ts'

// The identity panel of the Patient Workspace: the recorded A4.1 fields, each with its own label.
export function PatientSummary({ patient }: { patient: Patient }) {
  return (
    <section aria-labelledby="patient-details" className="mb-8 rounded-lg border border-slate-200 bg-white p-5">
      <h2 id="patient-details" className="text-sm font-semibold text-slate-950">
        Patient details
      </h2>
      <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        <DetailItem label="Full name" value={patient.displayName} />
        <DetailItem label="Date of birth" value={formatDateOnly(patient.dateOfBirth)} />
        <DetailItem label="Mobile phone" value={patient.mobilePhone} />
        <DetailItem label="Email" value={patient.email} />
      </dl>
    </section>
  )
}
