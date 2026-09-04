import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import type { JobEnvelope, WorkerStatus } from './worker.types.ts'
import { runJob } from './worker.runner.ts'

let status: WorkerStatus = 'STARTING'
let stopping = false
let activeJob: Promise<unknown> | null = null

function log(message: string) {
  console.log(`[worker] ${message}`)
}

async function runSyntheticDemo() {
  status = 'RUNNING'
  const job: JobEnvelope = {
    id: randomUUID(),
    type: 'NOOP_SYNTHETIC',
    createdAt: new Date().toISOString(),
    payload: { message: 'synthetic demo job' },
  }
  const result = await runJob(job)
  log(`demo result ok=${result.ok} jobId=${result.jobId} type=${result.type}`)
  status = 'READY'
}

async function shutdown(signal: string) {
  if (stopping) {
    log(`second ${signal} received, forcing exit`)
    process.exit(1)
  }
  stopping = true
  status = 'STOPPING'
  log(`stopping signal=${signal}`)

  if (activeJob) {
    await activeJob.catch(() => {})
  }

  status = 'STOPPED'
  log('stopped')
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

status = 'READY'
log('ready')

if (process.env.WORKER_RUN_SYNTHETIC_DEMO === 'true') {
  activeJob = runSyntheticDemo().finally(() => {
    activeJob = null
  })
}
