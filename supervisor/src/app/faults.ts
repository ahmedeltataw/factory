export type FaultName = 'outbox-before-effect' | 'outbox-after-effect' | 'attempt-after-spawn'
export const FAULT_NAMES: readonly FaultName[] = ['outbox-before-effect', 'outbox-after-effect', 'attempt-after-spawn']

export function parseFault(value: string | undefined): FaultName | undefined {
  if (value === undefined || value === '') return undefined
  if (FAULT_NAMES.includes(value as FaultName)) return value as FaultName
  throw new Error(`unknown fault: ${value}`)
}

export function triggerFault(_fault: FaultName): never {
  process.kill(process.pid, 'SIGKILL')
  throw new Error('process termination failed')
}
