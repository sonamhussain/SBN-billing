import type { JobEnvelope, JobHandler, JobResult, JobType } from './worker.types.ts'
import { jobRegistry } from './worker.registry.ts'

export async function runJob(
  job: JobEnvelope,
  registry: Record<JobType, JobHandler> = jobRegistry,
): Promise<JobResult> {
  const startedAt = new Date().toISOString()
  const handler = registry[job.type]

  try {
    await handler(job)
    return { ok: true, jobId: job.id, type: job.type, startedAt, finishedAt: new Date().toISOString() }
  } catch {
    return {
      ok: false,
      jobId: job.id,
      type: job.type,
      startedAt,
      finishedAt: new Date().toISOString(),
      errorCode: 'JOB_FAILED',
    }
  }
}
