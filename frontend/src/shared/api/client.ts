import { readApiError, type ApiError } from '../api-error.ts'

// FE-01 — the one HTTP boundary. Pages never make raw HTTP calls; feature API files (FE-02+) call
// apiRequest(). Patient/member/clinical values are never put in thrown error strings or logs.

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string

  constructor(status: number, error: ApiError) {
    super(error.message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = error.code
    this.requestId = error.requestId
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')

  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  })

  if (!response.ok) {
    throw new ApiClientError(response.status, await readApiError(response))
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
