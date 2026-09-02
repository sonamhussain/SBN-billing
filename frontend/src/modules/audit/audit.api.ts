export type AuditEvent = {
  id: string
  actorUserId: string
  actionCode: string
  entityType: string
  entityId: string
  occurredAt: string
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
}

type ErrorResponse = {
  error?: { message?: string }
}

export async function loadAuditEvents(organizationId: string): Promise<AuditEvent[]> {
  const response = await fetch(`/api/organizations/${organizationId}/audit-events`)

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ErrorResponse
    throw new Error(body.error?.message ?? `Request failed: ${response.status}`)
  }

  const data = (await response.json()) as { items: AuditEvent[] }
  return data.items
}
