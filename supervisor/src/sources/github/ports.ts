export type PollResult =
  | { kind: 'not-modified'; etag: string; pollAfterMs: number }
  | { kind: 'events'; etag: string; pollAfterMs: number; events: unknown[] }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'error'; retryable: boolean; message: string }

export interface GitHubPort {
  poll(input: { repo: string; etag: string | null }): Promise<PollResult>
}
