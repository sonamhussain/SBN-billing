import { readApiError } from '../../shared/api-error.ts'

// A5.4 — the minimal developer-check client.
//
// Line scope travels only in request and response bodies. Nothing is placed in a URL query, nothing
// is logged, and nothing is written to localStorage, sessionStorage or IndexedDB. Only SBN UUIDs
// appear in a path.
//
// There is deliberately no update, delete or single-line append call: a line set is captured once
// for one exact A5.3 version, and a correction is a new A5.3 version.

export type LineStatus = 'REQUESTED' | 'PENDING' | 'APPROVED' | 'PARTIALLY_APPROVED' | 'DENIED' | 'UNKNOWN'

export type AuthorizationLine = {
  id: string
  priorAuthorizationVersionId: string
  sequence: number
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  requestedQty: string
  approvedQty: string | null
  unitCode: string | null
  approvedFrom: string | null
  approvedThrough: string | null
  status: LineStatus
  createdByUserId: string
  createdAt: string
}

export type LineInput = {
  serviceId: string | null
  procedureCodeId: string | null
  diagnosisCodeId: string | null
  // Exact decimal strings. The client never turns a quantity into a JavaScript number.
  requestedQty: string
  approvedQty: string | null
  unitCode: string | null
  approvedFrom: string | null
  approvedThrough: string | null
  status: LineStatus
}

export type ScopeOutcome =
  | 'MATCHED'
  | 'NO_MATCH'
  | 'AMBIGUOUS'
  | 'CONTEXT_MISMATCH'
  | 'HEADER_STATUS_NOT_APPROVED'
  | 'LINE_STATUS_NOT_APPROVED'
  | 'DATE_OUTSIDE_SCOPE'
  | 'UNIT_MISMATCH'
  | 'QUANTITY_UNKNOWN'
  | 'QUANTITY_EXCEEDED'

export type ScopeEvaluation = {
  schemaVersion: 'AuthorizationScopeEvaluationV1'
  evaluatedAt: string
  priorAuthorizationId: string
  priorAuthorizationVersionId: string
  encounterId: string
  contextMatch: boolean
  activities: { encounterActivityId: string; outcome: ScopeOutcome; authorizationLineId: string | null; candidateAuthorizationLineIds: string[] }[]
  lineUtilization: { authorizationLineId: string; matchedActivityIds: string[]; matchedQty: string; approvedQty: string | null; quantityOutcome: 'WITHIN' | 'EXCEEDED' | 'UNKNOWN' }[]
}

async function handle<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const apiError = await readApiError(response)
    throw new Error(`${apiError.message} (requestId: ${apiError.requestId ?? 'unknown'})`)
  }
  return response.json() as Promise<T>
}

export async function captureLines(versionId: string, lines: LineInput[]): Promise<AuthorizationLine[]> {
  const body = await handle<{ items: AuthorizationLine[] }>(
    await fetch(`/api/prior-authorization-versions/${versionId}/authorization-lines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    }),
  )
  return body.items
}

export async function listLines(versionId: string): Promise<AuthorizationLine[]> {
  const body = await handle<{ items: AuthorizationLine[] }>(await fetch(`/api/prior-authorization-versions/${versionId}/authorization-lines`))
  return body.items
}

// Read-only. Nothing is stored and nothing is audited, however often it is called.
export async function evaluateScope(versionId: string): Promise<ScopeEvaluation> {
  return handle(await fetch(`/api/prior-authorization-versions/${versionId}/scope-evaluation`))
}
