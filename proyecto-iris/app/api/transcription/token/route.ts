import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { meetings } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!process.env.ASSEMBLYAI_API_KEY) return NextResponse.json({ error: 'Transcripción real no configurada.' }, { status: 503 })

  let body: { meetingId?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 }) }
  if (typeof body.meetingId !== 'string' || body.meetingId.length < 1 || body.meetingId.length > 128) return NextResponse.json({ error: 'Reunión inválida.' }, { status: 400 })
  const [meeting] = await db.select({ id: meetings.id }).from(meetings).where(and(eq(meetings.id, body.meetingId), eq(meetings.userId, session.user.id)))
  if (!meeting) return NextResponse.json({ error: 'Reunión no encontrada.' }, { status: 404 })

  const response = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60', { headers: { authorization: process.env.ASSEMBLYAI_API_KEY }, cache: 'no-store' })
  if (!response.ok) return NextResponse.json({ error: 'No se pudo conectar con el proveedor de transcripción.' }, { status: 502 })
  const payload = await response.json() as { token?: string }
  if (!payload.token) return NextResponse.json({ error: 'El proveedor no devolvió un token válido.' }, { status: 502 })
  return NextResponse.json({ token: payload.token })
}
