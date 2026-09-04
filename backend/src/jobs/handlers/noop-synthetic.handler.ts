import type { JobHandler } from '../worker.types.ts'

export const handleNoopSyntheticJob: JobHandler = async (job) => {
  console.log(`[worker] running ${job.type} id=${job.id} message=${job.payload.message}`)
}
