import { SimpleMasterSection, type MasterRecord } from '../admin/SimpleMasterSection.tsx'

// FE-05 — the coding masters with their owners' exact fields. Services, Procedure codes and Diagnosis codes
// stay independent: nothing maps a service to a procedure. A procedure code's code system and external code
// are preserved as recorded.

type Service = MasterRecord & { internalCode: string; displayName: string }
type ProcedureCode = MasterRecord & { internalCode: string; displayName: string; codeSystem: string | null; externalCode: string | null }
type DiagnosisCode = MasterRecord & { code: string; displayName: string }

export function CodingSetup() {
  return (
    <div className="space-y-10">
      <SimpleMasterSection<Service>
        title="Services"
        noun="services"
        subject="Service"
        owner={{ collection: 'services', read: 'service.read', create: 'service.create', update: 'service.update' }}
        fields={[
          { key: 'internalCode', label: 'Internal code', required: true },
          { key: 'displayName', label: 'Display name', required: true },
        ]}
        primary={(item) => `${item.internalCode} — ${item.displayName}`}
      />
      <SimpleMasterSection<ProcedureCode>
        title="Procedure codes"
        noun="procedure codes"
        subject="Procedure code"
        owner={{ collection: 'procedure-codes', read: 'procedure_code.read', create: 'procedure_code.create', update: 'procedure_code.update' }}
        fields={[
          { key: 'internalCode', label: 'Internal code', required: true },
          { key: 'displayName', label: 'Display name', required: true },
          { key: 'codeSystem', label: 'Code system' },
          { key: 'externalCode', label: 'External code' },
        ]}
        primary={(item) => `${item.internalCode} — ${item.displayName}`}
        secondary={(item) => (item.codeSystem || item.externalCode ? `${item.codeSystem ?? 'No code system'} · ${item.externalCode ?? 'no external code'}` : null)}
      />
      <SimpleMasterSection<DiagnosisCode>
        title="Diagnosis codes"
        noun="diagnosis codes"
        subject="Diagnosis code"
        owner={{ collection: 'diagnosis-codes', read: 'diagnosisCode.read', create: 'diagnosisCode.create', update: 'diagnosisCode.update' }}
        fields={[
          { key: 'code', label: 'Code', required: true },
          { key: 'displayName', label: 'Display name', required: true },
        ]}
        primary={(item) => `${item.code} — ${item.displayName}`}
      />
    </div>
  )
}
