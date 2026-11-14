import { NextResponse } from 'next/server'
import { z } from 'zod'
import { answerIrisMeetingQuestion } from '@/lib/iris-intelligence'
import { requireIrisUserId } from '@/lib/iris-session'

const directQuestionSchema = z.object({
  meetingId: z.string().trim().min(1).max(512),
  query: z.string().trim().min(1).max(1000),
  invocationId: z.string().trim().min(1).max(512),
  previousExchange: z.object({ user: z.string().trim().max(1000), iris: z.string().trim().max(4000) }).optional(),
}).strict()

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  if (origin) {
    try {
      const originUrl = new URL(origin)
      const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0].trim()
      const requestHost = forwardedHost || request.headers.get('host')?.split(',')[0].trim()
      const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim().replace(/:$/, '').toLowerCase()
      const expectedProtocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(request.url).protocol.toLowerCase()
      if (!requestHost || originUrl.host.toLowerCase() !== requestHost.toLowerCase() || originUrl.protocol.toLowerCase() !== expectedProtocol) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 })
    } catch { return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 }) }
  }

  let userId: string
  try { userId = await requireIrisUserId() } catch { return NextResponse.json({ error: 'No autorizado.' }, { status: 401 }) }

  let input: z.infer<typeof directQuestionSchema>
  try {
    const parsed = directQuestionSchema.safeParse(await request.json())
    if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 })
    input = parsed.data
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 })
  }

  const abortController = new AbortController()
  const abortForRequest = () => abortController.abort()
  if (request.signal.aborted) abortController.abort()
  else request.signal.addEventListener('abort', abortForRequest, { once: true })
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (event: unknown) => {
        if (closed || abortController.signal.aborted) return
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { closed = true; abortController.abort() }
      }
      void answerIrisMeetingQuestion(input.meetingId, userId, input.query, input.previousExchange, {
        signal: abortController.signal,
        onAnswerDelta: (delta) => send({ type: 'delta', delta }),
      }).then((answer) => send({ type: 'final', answer }))
        .catch(() => send({ type: 'error', message: 'No se pudo completar la respuesta de Iris.' }))
        .finally(() => {
          closed = true
          request.signal.removeEventListener('abort', abortForRequest)
          try { controller.close() } catch {}
        })
    },
    cancel() { abortController.abort() },
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
