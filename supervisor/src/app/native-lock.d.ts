// fs-native-extensions 1.5.3 ships no TypeScript declarations. tryLock/unlock
// are blocking-advisory OS file locks bound to an open fs file descriptor.
declare module 'fs-native-extensions' {
  /** Acquire an exclusive OS lock on fd without blocking; false when another holder owns it. */
  export function tryLock(fd: number): boolean
  /** Release the OS lock held on fd. */
  export function unlock(fd: number): void
}
