import { useRef, useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Paperclip, Trash2, Download, Loader2 } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { apiUrl, authHeader } from '@/lib/apiBase'
import { useConfirm } from '@/hooks/useConfirm'
import { errorMessage } from '@/hooks/useMutationWithToast'

const GET_ATTACHMENTS = gql`
  query GetAttachments($entityType: String!, $entityId: String!) {
    attachments(entityType: $entityType, entityId: $entityId) {
      id
      filename
      mimeType
      sizeBytes
      uploadedBy
      uploadedAt
      description
      downloadUrl
    }
  }
`

const DELETE_ATTACHMENT = gql`
  mutation DeleteAttachment($id: ID!) {
    deleteAttachment(id: $id)
  }
`

interface Attachment {
  id:          string
  filename:    string
  mimeType:    string
  sizeBytes:   number
  uploadedBy:  string
  uploadedAt:  string
  description: string | null
  downloadUrl: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  entityType: string
  entityId:   string
  /** Se la card è aperta di default (true per retrocompatibilità). */
  defaultOpen?: boolean
}

/**
 * Collapsible attachments card: list + upload + authenticated download.
 * Upload goes through REST POST /api/attachments (multipart); the download
 * needs the Bearer header, so it fetches a blob instead of a plain <a href>.
 */
export function AttachmentsSection({ entityType, entityId, defaultOpen = true }: Props) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const [uploading, setUploading] = useState(false)
  const fileInputRef              = useRef<HTMLInputElement>(null)

  const { data, refetch } = useQuery<{ attachments: Attachment[] }>(GET_ATTACHMENTS, {
    variables: { entityType, entityId },
  })
  const attachments = data?.attachments ?? []

  const [deleteAttachment] = useMutation(DELETE_ATTACHMENT, {
    onCompleted: () => { toast.success(t('attachments.deleted')); void refetch() },
    onError:     (e: { message: string }) => toast.error(e.message),
  })

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const form = new FormData()
        form.append('entityType', entityType)
        form.append('entityId', entityId)
        form.append('file', file)
        const res = await fetch(apiUrl('/api/attachments'), {
          method:  'POST',
          headers: authHeader(),
          body:    form,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string }
          throw new Error(body.error ?? res.statusText)
        }
      }
      toast.success(t('attachments.uploaded'))
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('attachments.uploadFailed'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function handleDownload(a: Attachment) {
    try {
      // `downloadUrl` is a `/api/...` path served by the API origin.
      const res = await fetch(a.downloadUrl.startsWith('/') ? apiUrl(a.downloadUrl) : a.downloadUrl, { headers: authHeader() })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href     = url
      link.download = a.filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      // The real cause (401, 404, network) must reach the user, not a generic label.
      toast.error(t('toast.attachments.downloadFailed', { error: errorMessage(err) }))
    }
  }

  async function handleDelete(a: Attachment) {
    const ok = await confirm({ title: t('attachments.confirmDelete'), body: a.filename, danger: true })
    if (ok) void deleteAttachment({ variables: { id: a.id } })
  }

  return (
    <SectionCard title={t('attachments.title')} count={attachments.length} collapsible defaultOpen={defaultOpen}>
        <div>
          {attachments.length === 0 && (
            <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-muted)', margin: '0 0 12px' }}>{t('attachments.empty')}</p>
          )}

          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
              {attachments.map((a) => (
                <div
                  key={a.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', backgroundColor: 'var(--surface-1)', borderRadius: 6 }}
                >
                  <button
                    type="button"
                    onClick={() => void handleDownload(a)}
                    title={t('attachments.download')}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-brand)', textAlign: 'left', flex: 1, minWidth: 0 }}
                  >
                    <Download size={13} style={{ flexShrink: 0 }} aria-hidden="true" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.filename}</span>
                  </button>
                  <span style={{ fontSize: 'var(--font-size-caption)', color: 'var(--text-muted)', flexShrink: 0 }}>{formatBytes(a.sizeBytes)}</span>
                  <button
                    type="button"
                    onClick={() => void handleDelete(a)}
                    title={t('common.delete')}
                    aria-label={`${t('common.delete')} ${a.filename}`}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--color-slate-light)', flexShrink: 0, display: 'flex' }}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', backgroundColor: '#fff', border: '1px dashed var(--border-strong)', borderRadius: 6, cursor: uploading ? 'default' : 'pointer', fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)' }}
          >
            {uploading ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Paperclip size={13} aria-hidden="true" />}
            {uploading ? t('attachments.uploading') : t('attachments.upload')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void handleUpload(e.target.files)}
          />
        </div>
    </SectionCard>
  )
}
