'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function ProposeForm() {
  const [text, setText] = useState('')
  const router = useRouter()

  async function submit() {
    const trimmed = text.trim()
    if (!trimmed) return
    const res = await fetch('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: trimmed }),
    })
    if (!res.ok) {
      const j = await res.json().catch(() => null)
      alert(j?.error || 'Could not submit right now — please try again later.')
      return
    }
    setText('')
    // Re-render the server page so the new proposal shows up in the feed.
    router.refresh()
  }

  return (
    <div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What should the app to do?"
        className="w-full bg-bg border border-fg text-fg font-mono text-[0.9rem] p-3 resize-y min-h-[72px] placeholder:text-muted focus:outline-none"
      />
      <button
        onClick={submit}
        className="mt-3 bg-fg text-bg border border-fg px-[1.1rem] py-[0.55rem] text-[0.85rem] font-semibold cursor-pointer hover:bg-bg hover:text-fg"
      >
        Submit
      </button>
    </div>
  )
}
