/**
 * Upload/download via REST `/api/attachments` — implementation in
 * `@opengraphity/web-core` (bearer header, multipart field order, blob download).
 */
import { createAttachments } from '@opengraphity/web-core'
import { api } from './api'

const attachments = createAttachments(api)

export const uploadAttachment   = attachments.uploadAttachment
export const downloadAttachment = attachments.downloadAttachment
