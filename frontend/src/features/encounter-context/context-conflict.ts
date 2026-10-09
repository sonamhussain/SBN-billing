import { ApiClientError } from '../../shared/api/client.ts'

// FE-04 — an A4.9 409 INTEGRITY_CONFLICT means the Encounter's stored context no longer coheres. Billing
// shows it and disables the actions that depend on a coherent context; it never falls back to another record.
export const isContextConflict = (error: unknown) => error instanceof ApiClientError && error.status === 409
