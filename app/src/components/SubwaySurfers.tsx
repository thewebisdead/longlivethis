'use client'

import { useEffect, useState } from 'react'

/**
 * A small Subway Surfers gameplay loop fixed in the bottom corner of the
 * screen — the classic "I'll just watch Subway Surfers while I work" bit.
 *
 * Rendered client-side so it can be fixed to the viewport regardless of page
 * scroll. Autoplays muted and looping (no user gesture needed), with an
 * unmute control for anyone who actually wants the audio. Hidden behind a
 * dismiss button so it never blocks the page's real content.
 */
export default function SubwaySurfers() {
  const [hidden, setHidden] = useState(false)
  const [muted, setMuted] = useState(true)
  const [videoRef, setVideoRef] = useState<HTMLVideoElement | null>(null)

  // Pause playback entirely when the tab is hidden so the loop doesn't burn
  // bandwidth/CPU for a video nobody is looking at.
  useEffect(() => {
    if (!videoRef) return
    const onVisibility = () => {
      if (document.hidden) videoRef.pause()
      else videoRef.play().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [videoRef])

  if (hidden) return null

  return (
    <div
      className="fixed bottom-3 right-3 z-50 w-40 sm:w-52 overflow-hidden rounded-lg border border-white/20 shadow-2xl select-none"
      aria-label="Subway Surfers gameplay video in the corner"
    >
      <video
        ref={setVideoRef}
        src="/subway-surfers.mp4"
        autoPlay
        loop
        muted={muted}
        playsInline
        preload="auto"
        className="block w-full"
      />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/70 px-2 py-1 text-[0.6rem] text-white">
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          className="hover:underline"
          aria-pressed={!muted}
        >
          {muted ? '🔇 unmute' : '🔊 mute'}
        </button>
        <button type="button" onClick={() => setHidden(true)} className="hover:underline">
          ✕ close
        </button>
      </div>
    </div>
  )
}
