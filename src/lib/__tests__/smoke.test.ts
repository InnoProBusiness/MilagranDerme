import { describe, it, expect } from 'vitest'

describe('ambiente de teste', () => {
  it('roda TypeScript com alias @/', async () => {
    const { ok } = await import('@/lib/smoke')
    expect(ok()).toBe(true)
  })
})
