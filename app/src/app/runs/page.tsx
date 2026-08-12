import RunTranscript from '@/components/RunTranscript'
import { listRuns, RUNS_REF } from '@/lib/runs'
import { repoUrl } from '@/lib/config'

export const dynamic = 'force-dynamic'

// A GitHub bounce must not blank the log; the runs lib serves stale-on-error
// and only surfaces a failure when there's nothing cached at all.
export default async function RunsPage() {
  const runs = await listRuns().catch(() => [])

  return (
    <main className="flex-1 w-full max-w-180 mx-auto px-6 py-12">
      <p className="text-[1.35rem] font-bold leading-tight mb-1 rainbow-text">🏃 Runs 🏃</p>
      <p className="text-[0.8rem] text-muted mb-8">
        A public, transcript-style log of past agent implement runs — stored on
        the <code className="text-fg">{RUNS_REF}</code> ref, one JSONL file per
        run.
        {repoUrl && (
          <>
            {' '}
            <a
              href={`${repoUrl}/tree/${RUNS_REF}`}
              target="_blank"
              rel="noopener"
              className="underline underline-offset-2 hover:text-fg"
            >
              Source
            </a>
          </>
        )}
      </p>

      {runs.length === 0 ? (
        <p className="text-muted text-[0.85rem] text-center my-12">
          No runs recorded yet. The next implemented proposal will appear here. 🤖✨
        </p>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <RunTranscript key={run.id} run={run} />
          ))}
        </div>
      )}
    </main>
  )
}
