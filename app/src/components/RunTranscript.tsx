'use client'

import { useState } from 'react'
import type { Run, RunEvent } from '@/lib/runs'

// Renders one run's event stream as a chat-style transcript:
//   - text events      → assistant messages
//   - tool_use events  → collapsible tool-call cards (command + output)
//   - step_start/finish→ turn dividers
// All client-side, from the exact event schema the implement stream emits.

function pretty(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function ToolCard({ event, defaultOpen }: { event: RunEvent; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const input = pretty(event.input ?? event.title ?? event.state)
  const output = pretty(event.resultSummary)

  return (
    <div className="border border-muted/40 rounded-sm my-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[0.72rem] hover:bg-fg/5"
      >
        <span className="text-muted shrink-0">{open ? '▾' : '▸'}</span>
        <span className="font-semibold truncate">{event.tool || event.type}</span>
        <span className="ml-auto text-[0.65rem] text-muted shrink-0">
          {open ? 'hide' : 'show'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3 text-[0.72rem] space-y-2">
          {input && (
            <pre className="whitespace-pre-wrap break-words bg-bg border border-muted/30 p-2 text-muted max-h-64 overflow-y-auto">
              {input}
            </pre>
          )}
          {output && (
            <pre className="whitespace-pre-wrap break-words bg-bg border border-muted/30 p-2 max-h-64 overflow-y-auto">
              {output}
            </pre>
          )}
          {!input && !output && <p className="text-muted italic">(no output)</p>}
        </div>
      )}
    </div>
  )
}

function StepDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 my-4 first:mt-0">
      <span className="text-[0.65rem] tracking-widest uppercase text-muted">{label}</span>
      <div className="flex-1 h-px bg-muted/30" />
    </div>
  )
}

export default function RunTranscript({ run }: { run: Run }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="border border-muted/40 rounded-sm">
      <button
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-fg/5"
      >
        <span className="text-muted shrink-0 text-[0.8rem]">{collapsed ? '▸' : '▾'}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[0.9rem] font-semibold truncate">{run.proposal}</span>
          <span className="flex flex-wrap gap-x-4 gap-y-0.5 text-[0.68rem] text-muted mt-0.5">
            {run.startedAt && <span>{new Date(run.startedAt).toISOString().slice(0, 16).replace('T', ' ')}Z</span>}
            {run.model && <span>{run.model}</span>}
            {run.outcome && <span className={run.outcome === 'success' ? '' : 'text-amber-400'}>{run.outcome === 'success' ? '✅' : '⚠️'} {run.outcome}</span>}
            {run.cost && <span>{run.cost}</span>}
          </span>
        </span>
        <span className="text-[0.7rem] text-muted shrink-0">{collapsed ? 'expand' : 'collapse'}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          {run.events.length === 0 ? (
            <p className="text-muted italic text-[0.8rem]">No events recorded for this run.</p>
          ) : (
            run.events.map((ev, i) => {
              switch (ev.type) {
                case 'text':
                  return ev.text?.trim() ? (
                    <div key={i} className="my-3 text-[0.82rem] leading-relaxed whitespace-pre-wrap break-words">
                      {ev.text}
                    </div>
                  ) : null
                case 'tool_use':
                  return <ToolCard key={i} event={ev} defaultOpen={false} />
                case 'step_start':
                case 'step_finish':
                  return <StepDivider key={i} label={ev.step || ev.type} />
                case 'error':
                  return (
                    <div key={i} className="my-3 border border-amber-400/50 text-amber-300 px-3 py-2 text-[0.8rem]">
                      {ev.error || ev.text || 'error'}
                    </div>
                  )
                default:
                  return null
              }
            })
          )}
        </div>
      )}
    </div>
  )
}
