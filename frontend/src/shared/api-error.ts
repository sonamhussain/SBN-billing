export type ApiError = {
  code: string
  message: string
  requestId?: string
}

export async function readApiError(response: Response): Promise<ApiError> {
  const fallback = { code: 'REQUEST_FAILED', message: 'request failed' }
  try {
    const body = await response.json()
    if (body?.error?.code && body?.error?.message) {
      return {
        code: String(body.error.code),
        message: String(body.error.message),
        requestId: body.error.requestId ? String(body.error.requestId) : undefined,
      }
    }
  } catch {}
  return fallback
}
