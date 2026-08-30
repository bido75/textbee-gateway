import { BatchResponse } from 'firebase-admin/messaging'

export const FCM_SEND_SKIPPED_ERROR_CODE = 'FCM_SEND_SKIPPED'

function parseIdList(envKey: string): string[] {
  return (process.env[envKey] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

// Accepts a string, an ObjectId, or a populated document
function normalizeId(value: unknown): string {
  if (!value) return ''
  const id = (value as { _id?: unknown })?._id ?? value
  return String(id)
}

// Withholds the push for accounts or devices listed in the environment while
// leaving the rest of the send path untouched
export function shouldSkipFcmSend(userId: unknown, deviceId: unknown): boolean {
  const user = normalizeId(userId)
  const device = normalizeId(deviceId)

  return (
    (!!user && parseIdList('FCM_SEND_SKIP_USER_IDS').includes(user)) ||
    (!!device && parseIdList('FCM_SEND_SKIP_DEVICE_IDS').includes(device))
  )
}

export function skippedBatchResponse(count: number): BatchResponse {
  return {
    successCount: count,
    failureCount: 0,
    responses: Array.from({ length: count }, () => ({
      success: true,
      messageId: FCM_SEND_SKIPPED_ERROR_CODE,
    })),
  }
}
