import { describe, expect, it } from 'vitest'

import { API_BASE_URL } from './snippets'

describe('API guide base URL', () => {
  it('uses the configured deployment API instead of the hosted TextBee API', () => {
    expect(API_BASE_URL).toBe(process.env.NEXT_PUBLIC_API_BASE_URL)
    expect(API_BASE_URL).not.toContain('api.textbee.dev')
  })
})
