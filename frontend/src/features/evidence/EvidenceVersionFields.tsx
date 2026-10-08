import { Field } from '../../shared/ui/Field.tsx'
import { Input } from '../../shared/ui/Input.tsx'
import type { EvidenceDraft } from './evidence-form.ts'

// FE-04 — evidence metadata fields shared by "Register evidence" and "Add evidence version". There is no
// file input: the storage reference and SHA-256 hash come from the real storage/manual workflow, so the
// frontend never receives file bytes and never calculates a hash. The document type is an opaque label.
export function EvidenceVersionFields({ draft, onChange }: { draft: EvidenceDraft; onChange: (next: EvidenceDraft) => void }) {
  const set = (key: keyof EvidenceDraft) => (value: string) => onChange({ ...draft, [key]: value })
  return (
    <>
      <p className="text-sm text-slate-500">Records metadata about a document held elsewhere. No file is uploaded here.</p>
      <Field label="Document type">
        <Input required autoComplete="off" value={draft.documentType} onChange={(e) => set('documentType')(e.target.value)} />
      </Field>
      <Field label="Storage reference" hint="(from the storage or manual workflow)">
        <Input required autoComplete="off" value={draft.storageRef} onChange={(e) => set('storageRef')(e.target.value)} />
      </Field>
      <Field label="Content hash" hint="(SHA-256, 64 hexadecimal characters)">
        <Input required autoComplete="off" spellCheck={false} value={draft.contentHash} onChange={(e) => set('contentHash')(e.target.value)} />
      </Field>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Received at">
          <Input type="datetime-local" required value={draft.receivedAt} onChange={(e) => set('receivedAt')(e.target.value)} />
        </Field>
        <Field label="Source date" hint="(optional)">
          <Input type="date" value={draft.sourceDate} onChange={(e) => set('sourceDate')(e.target.value)} />
        </Field>
      </div>
    </>
  )
}
