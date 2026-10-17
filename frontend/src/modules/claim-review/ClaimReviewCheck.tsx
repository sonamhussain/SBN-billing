import { useState, type FormEvent } from 'react'
import { readApiError } from '../../shared/api-error.ts'

// A6.5 — minimal READ-ONLY engineering check for human review decisions: list a Claim's review history in
// sequence order, read its derived review authority, and read one decision. Synthetic development data
// only. Only ids, decision and reason codes, sequence, fingerprint and instants are shown — no patient,
// member, payer, diagnosis text, amount or remark. Nothing here records, approves, returns, rejects or
// revokes, nothing is logged or kept in browser storage, and no product review screen is built here. The
// authority shown is exactly what the server derived; the page never decides it.

type Decision = {
  id: string
  draftAssessmentId: string
  reviewerUserId: string
  decisionCode: string
  sequence: number
  approvalFingerprint: string | null
  reasonCode: string | null
  referencedApprovalId: string | null
  reviewedAt: string
}

type Authority = {
  state: string
  decisionId: string | null
  draftAssessmentId: string | null
  fingerprint: string | null
  evaluatedAt: string
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

function DecisionLine({ decision }: { decision: Decision }) {
  return (
    <>
      #{decision.sequence} {decision.decisionCode} — decision {decision.id} — assessment {decision.draftAssessmentId} — reviewer {decision.reviewerUserId}
      {decision.reasonCode ? ` — ${decision.reasonCode}` : ''}
      {decision.referencedApprovalId ? ` — withdraws ${decision.referencedApprovalId}` : ''} — {decision.reviewedAt}
    </>
  )
}

export default function ClaimReviewCheck() {
  const [claimId, setClaimId] = useState('')
  const [decisionId, setDecisionId] = useState('')
  const [history, setHistory] = useState<Decision[] | null>(null)
  const [authority, setAuthority] = useState<Authority | null>(null)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setNotice('')
    try {
      await action()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }

  function handleHistory(event: FormEvent) {
    event.preventDefault()
    void run(async () => setHistory((await handle<{ items: Decision[] }>(await fetch(`/api/claims/${claimId.trim()}/review-decisions`))).items))
  }

  function handleAuthority(event: FormEvent) {
    event.preventDefault()
    void run(async () => setAuthority(await handle<Authority>(await fetch(`/api/claims/${claimId.trim()}/review-authority`))))
  }

  function handleRead(event: FormEvent) {
    event.preventDefault()
    void run(async () => setDecision(await handle<Decision>(await fetch(`/api/claim-review-decisions/${decisionId.trim()}`))))
  }

  const inputClass = 'rounded-md border border-slate-300 px-3 py-2'
  const buttonClass = 'rounded-md bg-slate-900 px-4 py-2 text-white disabled:opacity-50'

  return (
    <section className="mt-6 border-t border-slate-200 pt-6">
      <h2 className="text-lg font-semibold text-slate-900">Claim Review Decisions Check (A6.5)</h2>
      <p className="mt-1 text-sm text-slate-600">
        Synthetic development data only, read only. An approval is a recorded human authorization, never a submission; only the server-derived authority
        shown below says whether it is still current.
      </p>

      <form className="mt-4 grid gap-2" onSubmit={handleHistory}>
        <input className={inputClass} value={claimId} onChange={(event) => setClaimId(event.target.value)} placeholder="Claim UUID" aria-label="Claim UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          List review decisions (sequence order)
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleAuthority}>
        <button className={buttonClass} disabled={busy} type="submit">
          Read derived review authority of the claim above
        </button>
      </form>

      <form className="mt-4 grid gap-2" onSubmit={handleRead}>
        <input className={inputClass} value={decisionId} onChange={(event) => setDecisionId(event.target.value)} placeholder="Review decision UUID" aria-label="Review decision UUID" />
        <button className={buttonClass} disabled={busy} type="submit">
          Read review decision
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-slate-700">{notice}</p>}

      {history && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>{history.length} decision(s) in sequence order</p>
          <ul className="mt-1 grid gap-1">
            {history.map((item) => (
              <li key={item.id}>
                <DecisionLine decision={item} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {authority && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            Authority {authority.state} — decision {authority.decisionId ?? 'none'} — assessment {authority.draftAssessmentId ?? 'none'} — evaluated{' '}
            {authority.evaluatedAt}
          </p>
          {authority.fingerprint && <p className="break-all">Fingerprint {authority.fingerprint}</p>}
        </div>
      )}

      {decision && (
        <div className="mt-3 rounded-md bg-slate-100 p-3 text-sm text-slate-800">
          <p>
            <DecisionLine decision={decision} />
          </p>
          {decision.approvalFingerprint && <p className="break-all">Approved fingerprint {decision.approvalFingerprint}</p>}
        </div>
      )}
    </section>
  )
}
