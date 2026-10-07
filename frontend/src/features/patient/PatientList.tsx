import { Link } from 'react-router-dom'
import { formatDateOnly } from '../../shared/format/date.ts'
import type { Patient } from './patient.types.ts'

// Compact rows: name and date of birth only. No phone, email, member or policy value in the collection.
export function PatientList({ items }: { items: Patient[] }) {
  if (items.length === 0) return <p className="py-10 text-sm text-slate-500">No patients recorded yet.</p>

  return (
    <div className="divide-y divide-slate-200 border-y border-slate-200">
      {items.map((patient) => (
        <Link
          key={patient.id}
          to={`/app/patients/${patient.id}`}
          className="grid grid-cols-[1fr_10rem] gap-4 px-1 py-3.5 hover:bg-slate-50 focus-visible:bg-slate-50"
        >
          <div>
            <div className="font-medium text-slate-950">{patient.displayName}</div>
            <div className="mt-0.5 text-xs text-slate-500">Patient record</div>
          </div>
          <div className="text-sm text-slate-600">{formatDateOnly(patient.dateOfBirth)}</div>
        </Link>
      ))}
    </div>
  )
}
