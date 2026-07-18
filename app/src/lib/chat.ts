/**
 * In-memory chat store with SSE subscriber management.
 * Messages are ephemeral — they live only as long as the server process.
 * We keep the last 100 messages so new joiners see recent history.
 */

export interface ChatMessage {
  id: string
  text: string
  handle: string
  ts: number
}

const MAX_HISTORY = 100
const MAX_MESSAGE_LENGTH = 280
const MAX_HANDLE_LENGTH = 32

// Stored messages (last MAX_HISTORY)
const messages: ChatMessage[] = []

// SSE subscribers: each is a function that receives an encoded SSE line
type Subscriber = (data: string) => void
const subscribers = new Set<Subscriber>()

function broadcast(msg: ChatMessage) {
  const line = `data: ${JSON.stringify(msg)}\n\n`
  for (const sub of subscribers) {
    try {
      sub(line)
    } catch {
      // subscriber disconnected; will be removed on close
    }
  }
}

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function getHistory(): ChatMessage[] {
  return [...messages]
}

export function addMessage(rawHandle: string, rawText: string): ChatMessage | null {
  const handle = rawHandle.trim().replace(/[^\w\- .]/g, '').slice(0, MAX_HANDLE_LENGTH) || 'anon'
  const text = rawText.trim().slice(0, MAX_MESSAGE_LENGTH)
  if (!text) return null

  const msg: ChatMessage = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    handle,
    ts: Date.now(),
  }

  messages.push(msg)
  if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY)

  broadcast(msg)
  return msg
}
