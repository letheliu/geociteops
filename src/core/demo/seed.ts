import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { demoResetCommand, demoWorkspaceDomain, isDemoMode, planDemoBoot, type DemoEnv } from './mode.js'

export interface DemoSpawnResult {
  status: number | null
  error?: Error
}

export type DemoSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv; shell?: boolean },
) => DemoSpawnResult

function spawnAdapter(
  command: string,
  args: readonly string[],
  options: { cwd: string; stdio: 'inherit'; env: NodeJS.ProcessEnv },
): DemoSpawnResult {
  const result = spawnSync(command, args, options as SpawnSyncOptions)
  return { status: result.status, error: result.error }
}

/**
 * When demo mode is on and the fictional workspace has no citation queries yet,
 * run `scripts/reset-demo.mjs`. That script creates the Acme Draw org, the
 * read-only `demo-viewer` user, and the seeded reports. A later boot does not
 * wipe the workspace.
 *
 * The password is whatever `DEMO_ACCOUNT_PASSWORD` already is, or a random
 * value the script prints once. This function does not invent or log one.
 */
export async function ensureDemoSeed(
  countQueries: (domain: string) => Promise<number>,
  env: DemoEnv = process.env,
  spawnImpl: DemoSpawn = spawnAdapter,
  cwd: string = process.cwd(),
): Promise<'disabled' | 'skipped' | 'seeded'> {
  if (!isDemoMode(env)) return 'disabled'
  const domain = demoWorkspaceDomain(env)
  const citationQueryCount = await countQueries(domain)
  if (!planDemoBoot({ demoMode: true, citationQueryCount }).seed) {
    console.log(`[demo] ${domain} already has citation queries; skip seed`)
    return 'skipped'
  }
  const { command, args } = demoResetCommand()
  console.log(`[demo] seeding ${domain} via ${command} ${args.join(' ')}`)
  const result = spawnImpl(command, args, {
    cwd,
    stdio: 'inherit',
    env: env as NodeJS.ProcessEnv,
    // Windows resolves node_modules/.bin/tsx through a .cmd shim.
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `[demo] ${command} ${args.join(' ')} exited ${result.status ?? 'null'}. ` +
        'Apply migrations first, then run pnpm demo:reset.',
    )
  }
  return 'seeded'
}
