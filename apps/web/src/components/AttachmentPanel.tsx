import { useState, useRef } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Paperclip, Download, Trash2, Upload, FileText, Image, Archive, File } from 'lucide-react'
import { toast } from 'sonner'
import { keycloak } from '@/lib/keycloak'

const GET_ATTACHMENTS = gql`
  query GetAttachments($entityType: String!, $entityId: String!) {
    attachments(entityType: $entityType, entityId: $entityId) {
      id filename mimeType sizeBytes uploadedBy uploadedAt description downloadUrl
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

interface AttachmentPanelProps {
  entityType: string
  entityId:   string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024)       return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fileIcon(mimeType: string) {
  if (mimeType.startsWith('image/'))       return <Image size={16} color="#38bdf8" />
  if (mimeType === 'application/pdf')      return <FileText size={16} color="#ef4444" />
  if (mimeType.includes('zip'))            return <Archive size={16} color="#f59e0b" />
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return <FileText size={16} color="#22c55e" />
  if (mimeType.includes('word') || mimeType.includes('document'))     return <FileText size={16} color="#3b82f6" />
  return <File size={16} color="#94a3b8" />
}

const ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png', 'image/jpeg', 'image/gif',
  'text/plain', 'text/csv',
  'application/zip', 'application/x-zip-compressed',
]

export function AttachmentPanel({ entityType, entityId }: AttachmentPanelProps) {
  const { t }          = useTranslation()
  const fileInputRef   = useRef<HTMLInputElement>(null)
  const [uploading, setUploading]   = useState(false)
  const [dragOver,  setDragOver]    = useState(false)
  const [collapsed, setCollapsed]   = useState(false)
  const [deleteId,  setDeleteId]    = useState<string | null>(null)

  const { data, loading, refetch } = useQuery<{ attachments: Attachment[] }>(
    GET_ATTACHMENTS,
    { variables: { entityType, entityId }, fetchPolicy: 'cache-and-network' },
  )

  const [deleteAttachment] = useMutation(DELETE_ATTACHMENT, {
    onCompleted: () => { toast.success(t('attachments.deleted')); setDeleteId(null); void refetch() },
    onError: (e: { message: string }) => toast.error(e.message),
  })

  const attachments = data?.attachments ?? []

  async function uploadFile(file: File) {
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast.error(t('attachments.invalidType', { type: file.type }))
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('attachments.tooLarge'))
      return
    }

    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('entityType', entityType)
      fd.append('entityId', entityId)

      const token = keycloak.token ?? ''
      const res   = await fetch('/api/attachments', {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
        body:    fd,
      })

      if (!res.ok) {
        const err = await res.json() as { error?: string }
        throw new Error(err.error ?? 'Upload failed')
      }

      toast.success(t('attachments.uploaded'))
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files?.length) return
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      if (f) void uploadFile(f)
    }
  }

  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', marginTop: 16 }}>
      {/* Header */}
      <div
        onClick={() => setCollapsed((c) => !c)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: '#f8fafc', cursor: 'pointer', borderBottom: collapsed ? 'none' : '1px solid #e2e8f0' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Paperclip size={16} color="var(--color-brand)" />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {t('attachments.title')} {attachments.length > 0 && `(${attachments.length})`}
          </span>
        </div>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>{collapsed ? '▼' : '▲'}</span>
      </div>

      {!collapsed && (
        <div style={{ padding: 16 }}>
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? '#38bdf8' : '#e2e8f0'}`,
              borderRadius: 6,
              padding: '20px 16px',
              textAlign: 'center',
              cursor: 'pointer',
              background: dragOver ? '#f0f9ff' : '#fafafa',
              marginBottom: 12,
              transition: 'all 150ms',
            }}
          >
            <Upload size={20} color={dragOver ? '#38bdf8' : '#94a3b8'} style={{ margin: '0 auto 8px', display: 'block' }} />
            <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
              {uploading ? t('attachments.uploading') : t('attachments.dropHint')}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#94a3b8' }}>
              {t('attachments.maxSize')}
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_TYPES.join(',')}
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
          />

          {/* List */}
          {loading ? (
            <div style={{ fontSize: 13, color: '#94a3b8' }}>{t('common.loading')}</div>
          ) : attachments.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', padding: 8 }}>{t('attachments.noAttachments')}</div>
          ) : (
            attachments.map((att) => (
              <div
                key={att.id}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #f1f5f9' }}
              >
                {fileIcon(att.mimeType)}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: '#1a2332', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {att.filename}
                  </div>
                  <div style={{ fontSize: 11, color: '#94a3b8' }}>
                    {formatBytes(att.sizeBytes)} · {new Date(att.uploadedAt).toLocaleDateString()} · {att.uploadedBy}
                  </div>
                </div>
                <a
                  href={att.downloadUrl}
                  download={att.filename}
                  onClick={(e) => {
                    e.preventDefault()
                    void fetch(att.downloadUrl, { headers: { Authorization: `Bearer ${keycloak.token ?? ''}` } })
                      .then((r) => r.blob())
                      .then((blob) => {
                        const url = URL.createObjectURL(blob)
                        const a   = document.createElement('a')
                        a.href     = url
                        a.download = att.filename
                        a.click()
                        URL.revokeObjectURL(url)
                      })
                  }}
                  style={{ color: '#38bdf8', display: 'flex', alignItems: 'center' }}
                  title={t('common.download', 'Download')}
                >
                  <Download size={14} />
                </a>
                {deleteId === att.id ? (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      onClick={() => void deleteAttachment({ variables: { id: att.id } })}
                      style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}
                    >
                      {t('common.confirm')}
                    </button>
                    <button
                      onClick={() => setDeleteId(null)}
                      style={{ padding: '2px 8px', fontSize: 11, borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setDeleteId(att.id)}
                    style={{ color: '#94a3b8', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    title={t('common.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
