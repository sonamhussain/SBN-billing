import test from 'node:test'
import assert from 'node:assert/strict'
import { apiErrorHandler, apiNotFoundHandler } from './error.middleware.ts'
import { sendApiError } from './error-response.ts'
import { requestIdMiddleware } from '../http/request-id.middleware.ts'

const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function createMockResponse() {
  const res: any = {
    locals: { requestId: '550e8400-e29b-41d4-a716-446655440000' },
    statusCode: 0,
    body: undefined,
    headersSent: false,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
  return res
}

test('sendApiError emits {error:{code,message,requestId}}', () => {
  const res = createMockResponse()
  sendApiError(res, 400, 'VALIDATION_ERROR', 'name is required')

  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body, {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'name is required',
      requestId: '550e8400-e29b-41d4-a716-446655440000',
    },
  })
})

test('X-Request-Id is UUID-shaped and matches body requestId', () => {
  const res: any = {
    locals: {},
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined,
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }

  requestIdMiddleware({} as any, res, () => {})
  sendApiError(res, 400, 'VALIDATION_ERROR', 'name is required')

  assert.match(res.headers['X-Request-Id'], uuidShape)
  assert.equal(res.headers['X-Request-Id'], res.body.error.requestId)
})

test('malformed JSON classification maps to 400 INVALID_JSON', () => {
  const res = createMockResponse()
  const jsonParseError = Object.assign(new SyntaxError('Unexpected token'), {
    status: 400,
    type: 'entity.parse.failed',
  })

  apiErrorHandler(jsonParseError, {} as any, res, (() => {}) as any)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error.code, 'INVALID_JSON')
})

test('unknown Error maps to 500 INTERNAL_ERROR', () => {
  const res = createMockResponse()
  apiErrorHandler(new Error('db connection reset by peer'), {} as any, res, (() => {}) as any)

  assert.equal(res.statusCode, 500)
  assert.equal(res.body.error.code, 'INTERNAL_ERROR')
})

test('500 body does NOT contain thrown message or stack', () => {
  const res = createMockResponse()
  const secretError = new Error('SELECT * FROM user WHERE password_hash = ...')

  apiErrorHandler(secretError, {} as any, res, (() => {}) as any)

  const serialized = JSON.stringify(res.body)
  assert.equal(serialized.includes('password_hash'), false)
  assert.equal(serialized.includes(secretError.message), false)
  assert.equal(serialized.includes(secretError.stack ?? '__none__'), false)
})

test('apiNotFoundHandler maps to 404 NOT_FOUND', () => {
  const res = createMockResponse()
  apiNotFoundHandler({} as any, res)

  assert.equal(res.statusCode, 404)
  assert.equal(res.body.error.code, 'NOT_FOUND')
})
