import type { GitHubPort, PollResult } from './ports.ts'

export function createFakeGitHub(): GitHubPort & {
  push(repo: string, events: unknown[]): void
  script(repo: string, result: PollResult): void
  readonly calls: readonly { repo: string; etag: string | null }[]
} {
  const events = new Map<string, unknown[]>()
  const scripts = new Map<string, PollResult[]>()
  const calls: { repo: string; etag: string | null }[] = []
  return {
    calls,
    push(repo, page) { events.set(repo, [...(events.get(repo) ?? []), ...page]) },
    script(repo, result) { scripts.set(repo, [...(scripts.get(repo) ?? []), result]) },
    async poll(input) {
      calls.push({ repo: input.repo, etag: input.etag })
      const scripted = scripts.get(input.repo)?.shift()
      if (scripted) return scripted
      const page = events.get(input.repo) ?? []
      const etag = `e${page.length}`
      if (input.etag === etag) return { kind: 'not-modified', etag, pollAfterMs: 60000 }
      return { kind: 'events', etag, pollAfterMs: 60000, events: [...page].reverse() }
    },
  }
}
