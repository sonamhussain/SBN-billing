export type ApiResult = {
  status: number
  requestId: string | null
  body: any
  setCookies: string[]
}

export async function callApi(baseUrl: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const body = await response.json().catch(() => null)

  return {
    status: response.status,
    requestId: response.headers.get('x-request-id'),
    body,
    setCookies: (response.headers as any).getSetCookie?.() ?? [],
  }
}

export function extractCookieHeader(setCookies: string[]): string {
  return setCookies.map((c) => c.split(';')[0]).join('; ')
}

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && uuidShape.test(value)
}
