import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// CRG-01 Checkpoint A — minimal read-only engineering check that shows the coding-release decision of one encounter's codes.
// Synthetic development data only. The page reads once on request, never writes, never polls, keeps nothing in
// browser storage and logs nothing. A decision is a preparation answer: it blocks no claim and is not verified law.

type Edition = { referenceDatasetVersionId: string; edition: string; effectiveFrom: string; effectiveTo: string | null; contentHash: string }

type Item = {
  subjectKind: string
  subjectId: string
  masterCodeId: string
  decisionCode: string
  codeSystem: string | null
  edition: Edition | null
  membership: { membershipId: string; sourceRowId: string; sourceRowSha256: string } | null
}

type Check = { serviceDate: string; jurisdictionCode: string; authorityCode: string; items: Item[]; evaluatedAt: string }

export default function CodingReleaseCheck() {
  const [encounterId, setEncounterId] = useState('')
  const [check, setCheck] = useState<Check | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleRead(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setNotice('')
    setCheck(null)
    try {
      const response = await fetch(`/api/encounters/${encounterId.trim()}/coding-release-check`)
      if (!response.ok) {
        const apiError = await readApiError(response)
        throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
      }
      setCheck((await response.json()) as Check)
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Coding Release Check (CRG-01 Checkpoint A)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. Shows, for one encounter, the coding edition that governs each code on the encounter's service date and
        whether the code is in that edition. Preparation only: nothing is blocked or activated.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className="rounded-md border border-slate-300 px-3 py-2" value={encounterId} onChange={(event) => setEncounterId(event.target.value)} placeholder="Encounter UUID" aria-label="Encounter UUID" />
        <button className="rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50" disabled={busy} type="submit">
          Read coding release check (read only)
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {check && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Service date {check.serviceDate} — {check.jurisdictionCode} / {check.authorityCode} ({check.items.length} code(s), evaluated {check.evaluatedAt})
          </p>
          <ol className="mt-2 grid gap-1">
            {check.items.map((item) => (
              <li key={item.subjectId} className="break-all">
                {item.subjectKind} {item.masterCodeId} — {item.decisionCode}
                {item.codeSystem && ` (${item.codeSystem})`}
                {item.edition && ` — edition ${item.edition.edition} ${item.edition.effectiveFrom}..${item.edition.effectiveTo ?? 'open'} [${item.edition.referenceDatasetVersionId}]`}
                {item.membership && ` — source row ${item.membership.sourceRowId} ${item.membership.sourceRowSha256.slice(0, 12)}…`}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
