import { describe, expect, it } from 'vitest'
import { ownsResource } from './iris-authorization'

describe('Iris resource authorization', () => {
  it('allows a user to access their own resource', () => {
    expect(ownsResource('user-a', 'user-a')).toBe(true)
  })

  it('rejects another user resource and missing ownership', () => {
    expect(ownsResource('user-b', 'user-a')).toBe(false)
    expect(ownsResource(undefined, 'user-a')).toBe(false)
  })
})
