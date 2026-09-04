import type { JobHandler, JobType } from './worker.types.ts'
import { handleNoopSyntheticJob } from './handlers/noop-synthetic.handler.ts'

export const jobRegistry = {
  NOOP_SYNTHETIC: handleNoopSyntheticJob,
} satisfies Record<JobType, JobHandler>
