import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured')
  }

  const url = new URL(databaseUrl)
  const sslMode = url.searchParams.get('sslmode')

  if (sslMode === 'prefer' || sslMode === 'require' || sslMode === 'verify-ca') {
    url.searchParams.set('sslmode', 'verify-full')
  }

  return url.toString()
}

export const pool = new Pool({ connectionString: getDatabaseUrl(), max: 5 })
export const db = drizzle(pool, { schema })
