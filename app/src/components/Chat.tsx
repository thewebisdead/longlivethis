'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@/lib/chat'

const MAX_HANDLE = 32
const MAX_TEXT = 280

export default function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [handle, setHandle] = useState('')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [connected, setConnected] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const seenIds = useRef(new Set<string>())

  // SSE connection
  useEffect(() => {
    let es: EventSource
    let retryTimer: ReturnType<typeof setTimeout>

    function connect() {
      es = new EventSource('/api/chat')

      es.onopen = () => setConnected(true)

      es.onmessage = (e) => {
        try {
          const msg: ChatMessage = JSON.parse(e.data)
          if (seenIds.current.has(msg.id)) return
          seenIds.current.add(msg.id)
          setMessages((prev) => [...prev, msg].slice(-100))
        } catch {
          // ignore malformed
        }
      }

      es.onerror = () => {
        setConnected(false)
        es.close()
        retryTimer = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => {
      es?.close()
      clearTimeout(retryTimer)
    }
  }, [])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: handle.trim() || 'anon', text: t }),
      })
      if (res.ok) {
        setText('')
      }
    } finally {
      setSending(false)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function fmt(ts: number) {
    const d = new Date(ts)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="mt-10">
      <h2 className="text-[0.8rem] tracking-widest text-muted uppercase mb-4 flex items-center gap-2">
        Live Chat
        <span
          className={`inline-block w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          title={connected ? 'connected' : 'reconnecting…'}
        />
      </h2>

      {/* Message log */}
      <div className="border border-fg h-64 overflow-y-auto p-3 text-[0.8rem] space-y-2 mb-3">
        {messages.length === 0 ? (
          <p className="text-muted">No messages yet. Say something!</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="leading-snug">
              <span className="text-muted mr-2">{fmt(m.ts)}</span>
              <span className="font-semibold mr-1">{m.handle}:</span>
              <span className="break-all">{m.text}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div className="flex gap-2 flex-wrap">
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value.slice(0, MAX_HANDLE))}
          placeholder="handle (optional)"
          className="bg-bg border border-fg text-fg font-mono text-[0.8rem] px-2 py-1 w-28 placeholder:text-muted focus:outline-none shrink-0"
        />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
          onKeyDown={handleKey}
          placeholder="message…"
          className="bg-bg border border-fg text-fg font-mono text-[0.8rem] px-2 py-1 flex-1 min-w-0 placeholder:text-muted focus:outline-none"
        />
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="bg-fg text-bg border border-fg px-4 py-1 text-[0.8rem] font-semibold cursor-pointer hover:bg-bg hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          Send
        </button>
      </div>
      <p className="text-[0.7rem] text-muted mt-1">
        Messages are ephemeral — they disappear on server restart.
      </p>
    </div>
  )
}
