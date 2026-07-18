/**
 * GET  /api/chat  — SSE stream of live chat messages
 * POST /api/chat  — send a message { handle, text }
 */

import { NextResponse } from 'next/server'
import { addMessage, getHistory, subscribe } from '@/lib/chat'

export const dynamic = 'force-dynamic'

export async function GET() {
  const history = getHistory()

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()

      // Send history first
      for (const msg of history) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(msg)}\n\n`))
      }

      // Keep-alive comment every 20 s
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'))
        } catch {
          clearInterval(keepAlive)
        }
      }, 20_000)

      const unsub = subscribe((line) => {
        try {
          controller.enqueue(enc.encode(line))
        } catch {
          unsub()
          clearInterval(keepAlive)
        }
      })

      // Clean up when client disconnects (stream cancel)
      return () => {
        unsub()
        clearInterval(keepAlive)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

export async function POST(req: Request) {
  let body: { handle?: string; text?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const msg = addMessage(body.handle ?? 'anon', body.text ?? '')
  if (!msg) return NextResponse.json({ error: 'text required' }, { status: 400 })

  return NextResponse.json(msg, { status: 201 })
}
