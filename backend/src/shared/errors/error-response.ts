import type { Response } from 'express'
import type { ApiErrorCode } from './error.types.ts'

export function sendApiError(
  res: Response,
  status: number,
  code: ApiErrorCode,
  message: string,
) {
  const requestId = String(res.locals.requestId ?? 'unknown')
  res.status(status).json({ error: { code, message, requestId } })
}
