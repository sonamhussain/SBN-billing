export type WorkerStatus =
  | 'STARTING'
  | 'READY'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'

export type JobType = 'NOOP_SYNTHETIC'

export type JobEnvelope = {
  id: string
  type: JobType
  createdAt: string
  payload: { message: string }
}

export type JobResult =
  | { ok: true; jobId: string; type: JobType; startedAt: string; finishedAt: string }
  | {
      ok: false
      jobId: string
      type: JobType
      startedAt: string
      finishedAt: string
      errorCode: 'JOB_FAILED'
    }

export type JobHandler = (job: JobEnvelope) => Promise<void>
