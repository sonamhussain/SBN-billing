import { SimpleMasterSection, type MasterRecord } from '../admin/SimpleMasterSection.tsx'
import { ClinicianDetailSheet } from './ClinicianDetailSheet.tsx'

// FE-05 — Clinicians and Specialties as two separate masters (display name only). They are never joined
// here; a Clinician's recorded specialty and facility assignments are owner records shown read-only in the
// Clinician's detail.

type NamedMaster = MasterRecord & { displayName: string }

const nameField = [{ key: 'displayName', label: 'Display name', required: true }]

export function ClinicalSetup() {
  return (
    <div className="space-y-10">
      <SimpleMasterSection<NamedMaster>
        title="Clinicians"
        noun="clinicians"
        subject="Clinician"
        owner={{ collection: 'clinicians', read: 'clinician.read', create: 'clinician.create', update: 'clinician.update' }}
        fields={nameField}
        primary={(item) => item.displayName}
        detail={(item) => <ClinicianDetailSheet clinicianId={item.id} name={item.displayName} />}
      />
      <SimpleMasterSection<NamedMaster>
        title="Specialties"
        noun="specialties"
        subject="Specialty"
        owner={{ collection: 'specialties', read: 'specialty.read', create: 'specialty.create', update: 'specialty.update' }}
        fields={nameField}
        primary={(item) => item.displayName}
      />
    </div>
  )
}
