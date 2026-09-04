import test from 'node:test'
import assert from 'node:assert/strict'
import { runJob } from './worker.runner.ts'
import type { JobEnvelope, JobHandler, JobType } from './worker.types.ts'

function makeJob(): JobEnvelope {
  return {
    id: 'test-job-1',
    type: 'NOOP_SYNTHETIC',
    createdAt: new Date().toISOString(),
    payload: { message: 'unit test job' },
  }
}

test('runJob returns success for the approved NOOP_SYNTHETIC handler', async () => {
  const result = await runJob(makeJob())

  assert.equal(result.ok, true)
  assert.equal(result.jobId, 'test-job-1')
  assert.equal(result.type, 'NOOP_SYNTHETIC')
  assert.ok(result.startedAt)
  assert.ok(result.finishedAt)
})

test('runJob contains a throwing handler as JOB_FAILED, never crashes', async () => {
  const throwingHandler: JobHandler = async () => {
    throw new Error('synthetic handler failure for unit test')
  }
  const testRegistry: Record<JobType, JobHandler> = {
    NOOP_SYNTHETIC: throwingHandler,
  }

  const result = await runJob(makeJob(), testRegistry)

  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errorCode, 'JOB_FAILED')
  }
  assert.equal(result.jobId, 'test-job-1')
})

test('runJob failure result never contains the thrown message', async () => {
  const throwingHandler: JobHandler = async () => {
    throw new Error('SELECT * FROM user WHERE password_hash = secret')
  }
  const testRegistry: Record<JobType, JobHandler> = {
    NOOP_SYNTHETIC: throwingHandler,
  }

  const result = await runJob(makeJob(), testRegistry)
  const serialized = JSON.stringify(result)

  assert.equal(serialized.includes('password_hash'), false)
  assert.equal(serialized.includes('SELECT'), false)
})
