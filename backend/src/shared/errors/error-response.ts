import type { Response } from 'express'
import type { ApiErrorCode } from './error.types.ts'

export function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
  reason?: string,
) {
  const requestId = String(res.locals.requestId ?? 'unknown')
  // The reason key is added only when supplied, so every existing caller emits exactly the shape it
  // always did.
  res.status(status).json({ error: reason === undefined ? { code, message, requestId } : { code, message, requestId, reason } })
}
