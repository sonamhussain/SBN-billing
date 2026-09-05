import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const backendRoot = path.resolve(fileURLToPath(import.meta.url), '../../../..')

export type WorkerRunOutcome = {
  sawReady: boolean
  sawDemoSuccess: boolean
  gracefulStop: boolean
  output: string
}

export async function runWorkerAcceptance(demoFlag: boolean): Promise<WorkerRunOutcome> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--env-file=.env', 'src/jobs/worker.ts'], {
      cwd: backendRoot,
      env: { ...process.env, WORKER_RUN_SYNTHETIC_DEMO: String(demoFlag) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let sawReady = false
    let sawDemoSuccess = false
    let settled = false

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      output += text
      if (text.includes('[worker] ready')) sawReady = true
      if (text.includes('demo result ok=true')) sawDemoSuccess = true
    })
    child.stderr.on('data', (chunk) => { output += chunk.toString() })

    function finish(gracefulStop: boolean) {
      if (settled) return
      settled = true
      resolve({ sawReady, sawDemoSuccess, gracefulStop, output })
    }

    // give the worker time to reach READY (and run the demo job if requested)
    setTimeout(() => {
      // attempt a graceful stop; this environment cannot reliably deliver
      // SIGTERM to a spawned child on Windows, so we fall back to a forced
      // stop and report gracefulStop:false rather than hang the harness.
      const beforeExitOutputLength = output.length
      child.kill('SIGTERM')

      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGKILL')
        }
        const graceful = output.slice(beforeExitOutputLength).includes('[worker] stopped')
        finish(graceful)
      }, 1500)
    }, demoFlag ? 1200 : 800)

    child.on('close', () => finish(output.includes('[worker] stopped')))
  })
}
