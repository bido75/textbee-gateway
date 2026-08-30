import { Types } from 'mongoose'
import {
  FCM_SEND_SKIPPED_ERROR_CODE,
  shouldSkipFcmSend,
  skippedBatchResponse,
} from './fcm-send-skip'

describe('fcm-send-skip', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('shouldSkipFcmSend', () => {
    const userId = '64b7f0000000000000000001'
    const deviceId = '64b7f0000000000000000002'

    it('skips nothing when the lists are unset or empty', () => {
      expect(shouldSkipFcmSend(userId, deviceId)).toBe(false)

      process.env.FCM_SEND_SKIP_USER_IDS = ''
      process.env.FCM_SEND_SKIP_DEVICE_IDS = '  , '
      expect(shouldSkipFcmSend(userId, deviceId)).toBe(false)
    })

    it('matches a listed user id', () => {
      process.env.FCM_SEND_SKIP_USER_IDS = userId

      expect(shouldSkipFcmSend(userId, deviceId)).toBe(true)
    })

    it('matches a listed device id', () => {
      process.env.FCM_SEND_SKIP_DEVICE_IDS = deviceId

      expect(shouldSkipFcmSend(userId, deviceId)).toBe(true)
    })

    it('ignores whitespace around comma separated ids', () => {
      process.env.FCM_SEND_SKIP_USER_IDS = ` 64b7f0000000000000000009 , ${userId} `

      expect(shouldSkipFcmSend(userId, deviceId)).toBe(true)
    })

    it('does not match an unlisted id', () => {
      process.env.FCM_SEND_SKIP_USER_IDS = '64b7f0000000000000000009'
      process.env.FCM_SEND_SKIP_DEVICE_IDS = '64b7f0000000000000000008'

      expect(shouldSkipFcmSend(userId, deviceId)).toBe(false)
    })

    it('accepts an ObjectId or a populated document', () => {
      process.env.FCM_SEND_SKIP_USER_IDS = userId

      expect(shouldSkipFcmSend(new Types.ObjectId(userId), deviceId)).toBe(true)
      expect(
        shouldSkipFcmSend({ _id: new Types.ObjectId(userId) }, deviceId),
      ).toBe(true)
    })

    it('never matches on a missing id', () => {
      process.env.FCM_SEND_SKIP_USER_IDS = userId
      process.env.FCM_SEND_SKIP_DEVICE_IDS = deviceId

      expect(shouldSkipFcmSend(undefined, undefined)).toBe(false)
      expect(shouldSkipFcmSend(null, '')).toBe(false)
    })
  })

  describe('skippedBatchResponse', () => {
    it('reports every message as a success', () => {
      const response = skippedBatchResponse(2)

      expect(response.successCount).toBe(2)
      expect(response.failureCount).toBe(0)
      expect(response.responses).toEqual([
        { success: true, messageId: FCM_SEND_SKIPPED_ERROR_CODE },
        { success: true, messageId: FCM_SEND_SKIPPED_ERROR_CODE },
      ])
    })

    it('handles an empty batch', () => {
      expect(skippedBatchResponse(0)).toEqual({
        successCount: 0,
        failureCount: 0,
        responses: [],
      })
    })
  })
})
