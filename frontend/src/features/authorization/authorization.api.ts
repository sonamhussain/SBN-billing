import { apiRequest } from '../../shared/api/client.ts'
import type {
  AuthorizationLine,
  AuthorizationLineInput,
  AuthorizationScopeEvaluation,
  AuthorizationVersionInput,
  PriorAuthorization,
  PriorAuthorizationVersion,
} from './authorization.types.ts'

// FE-04 — real A5.3/A5.4 routes only. Recording an authorization stores history; it never requests or
// submits anything to a payer. There is no update or delete. The authorization reference travels only in
// request bodies.

export function listEncounterAuthorizations(encounterId: string) {
  return apiRequest<{ items: PriorAuthorization[] }>(`/api/encounters/${encounterId}/prior-authorizations`)
}

export function recordAuthorization(encounterId: string, input: AuthorizationVersionInput) {
  return apiRequest<PriorAuthorization>(`/api/encounters/${encounterId}/prior-authorizations`, { method: 'POST', body: JSON.stringify(input) })
}

export function listAuthorizationVersions(authorizationId: string) {
  return apiRequest<{ items: PriorAuthorizationVersion[] }>(`/api/prior-authorizations/${authorizationId}/versions`)
}

export function addAuthorizationVersion(authorizationId: string, input: AuthorizationVersionInput) {
  return apiRequest<PriorAuthorizationVersion>(`/api/prior-authorizations/${authorizationId}/versions`, { method: 'POST', body: JSON.stringify(input) })
}

export function listAuthorizationLines(versionId: string) {
  return apiRequest<{ items: AuthorizationLine[] }>(`/api/prior-authorization-versions/${versionId}/authorization-lines`)
}

// One complete, non-empty batch per exact version.
export function captureAuthorizationLines(versionId: string, lines: AuthorizationLineInput[]) {
  return apiRequest<{ items: AuthorizationLine[] }>(`/api/prior-authorization-versions/${versionId}/authorization-lines`, {
    method: 'POST',
    body: JSON.stringify({ lines }),
  })
}

export function evaluateAuthorizationScope(versionId: string) {
  return apiRequest<AuthorizationScopeEvaluation>(`/api/prior-authorization-versions/${versionId}/scope-evaluation`)
}
