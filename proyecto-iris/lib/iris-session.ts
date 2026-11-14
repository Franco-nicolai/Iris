import { headers } from 'next/headers'
import { auth } from '@/lib/auth'

export const IRIS_DEMO_USER = {
  id: 'iris-local-demo-user',
  name: 'Iris Demo',
  email: 'iris-demo@localhost',
} as const

export function isIrisDemoAuthEnabled() {
  // Temporary development/demo access also needs to work in the v0 preview,
  // where Next runs with NODE_ENV=production. Disable explicitly before shipping.
  return process.env.IRIS_DEMO_AUTH_BYPASS !== 'false'
}

export async function getIrisUser() {
  if (isIrisDemoAuthEnabled()) return IRIS_DEMO_USER

  const session = await auth.api.getSession({ headers: await headers() })
  return session?.user ?? null
}

export async function requireIrisUserId() {
  const user = await getIrisUser()
  if (!user?.id) throw new Error('Unauthorized')
  return user.id
}
