import type { Request, Response, NextFunction } from 'express'
import { sendApiError } from './error-response.ts'

function isJsonParseError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false
  const x = error as SyntaxError & { status?: number; type?: string }
  return x.status === 400 && x.type === 'entity.parse.failed'
}

export function apiNotFoundHandler(_req: Request, res: Response) {
  sendApiError(res, 404, 'NOT_FOUND', 'api route not found')
}

export function apiErrorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (isJsonParseError(error)) {
    sendApiError(res, 400, 'INVALID_JSON', 'invalid JSON body')
    return
  }

  if (res.headersSent) return
  sendApiError(res, 500, 'INTERNAL_ERROR', 'unexpected server error')
}
