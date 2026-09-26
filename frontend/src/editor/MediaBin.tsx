import { AlertTriangle, Film, Image as ImageIcon, Music, Plus, RotateCw, Trash2, Type, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Asset } from '../api/types'
import { toast } from '../components/toast'
import { ApiImg } from '../lib/apiImage'
import { Button, IconButton, Modal, ProgressBar, Spinner } from '../components/ui'
import { formatBytes, formatDuration, uid } from '../lib/format'
import { useEditor } from './store'

export const ASSET_MIME = 'application/x-yabbe-asset'
const ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.m4a,.flac,.opus,.webm'

export function MediaBin({ projectId, onAdded }: { projectId: string; onAdded?: () => void }) {
  const assets = useEditor((s) => s.assets)
  const uploads = useEditor((s) => s.uploads)
  const fileRef = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState<'all' | 'video' | 'audio' | 'image'>('all')
  const [dragOver, setDragOver] = useState(false)

  const uploadFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) uploadOne(projectId, file)
  }

  // Dropping files anywhere on the window uploads them.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault()
        setDragOver(true)
      }
    }
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false)
    }
    const drop = (e: DragEvent) => {
      if (e.dataTransfer?.files.length) {
        e.preventDefault()
        uploadFiles(e.dataTransfer.files)
      }
      setDragOver(false)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const shown = [...assets].filter((a) => filter === 'all' || a.kind === filter).sort((a, b) => b.created_at - a.created_at)

  return (
    <>
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        {/* In the phone sheet the sheet itself carries the title. */}
        {!onAdded && <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Media</h2>}
        <div className={`flex gap-1 ${onAdded ? 'w-full justify-end' : ''}`}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              useEditor.getState().addTextClip()
              onAdded?.()
            }}
            title="Add text (T)"
          >
            <Type size={13} /> Text
          </Button>
          <Button size="sm" onClick={() => fileRef.current?.click()}>
            <Upload size={13} /> Upload
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <div className="flex gap-1 border-b border-line px-3 py-2">
        {(['all', 'video', 'audio', 'image'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-2 py-1 text-xs capitalize transition-colors ${
              filter === f ? 'bg-raised text-fg' : 'text-muted hover:text-fg'
            }`}
          >
            {f === 'image' ? 'Photos' : f}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {uploads.map((u) => (
          <div key={u.id} className="mb-2 rounded-lg border border-line bg-panel-2 p-2.5">
            <div className="flex items-center gap-2 text-xs">
              <Spinner size={12} />
              <span className="flex-1 truncate">{u.name}</span>
              <span className="tabular text-muted">{Math.round(u.progress * 100)}%</span>
            </div>
            <ProgressBar value={u.progress} className="mt-2" />
          </div>
        ))}

        {shown.length === 0 && uploads.length === 0 ? (
          <button
            onClick={() => fileRef.current?.click()}
            className={`flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center transition-colors ${
              dragOver ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong'
            }`}
          >
            <Upload size={20} className="text-faint" />
            <span className="font-medium pointer-coarse:hidden">Drop videos, audio or photos</span>
            <span className="hidden font-medium pointer-coarse:inline">Add videos, audio or photos</span>
            <span className="text-xs text-muted pointer-coarse:hidden">or click to browse</span>
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {shown.map((a) => (
              <AssetCard key={a.id} projectId={projectId} asset={a} onAdded={onAdded} />
            ))}
          </div>
        )}
      </div>

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-accent/10 ring-4 ring-accent/60 ring-inset">
          <div className="rounded-xl bg-panel px-6 py-4 font-medium shadow-2xl">Drop to upload</div>
        </div>
      )}
    </>
  )
}

async function uploadOne(projectId: string, file: File) {
  const id = uid('u_')
  const { setUploads } = useEditor.getState()
  setUploads((u) => [...u, { id, name: file.name, progress: 0 }])
  try {
    const asset = await api.uploadMedia(projectId, file, (progress) =>
      setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress } : x))),
    )
    const s = useEditor.getState()
    if (s.projectId === projectId) s.setAssets([...s.assets, asset])
  } catch (e) {
    toast.error(`${file.name}: ${e instanceof Error ? e.message : e}`)
  } finally {
    setUploads((u) => u.filter((x) => x.id !== id))
  }
}

const kindIcon = {
  video: <Film size={12} />,
  audio: <Music size={12} />,
  image: <ImageIcon size={12} />,
}

function AssetCard({ projectId, asset, onAdded }: { projectId: string; asset: Asset; onAdded?: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const used = useEditor((s) => s.doc.clips.filter((c) => c.asset_id === asset.id).length)
  const ready = asset.status === 'ready'
  const hasPoster = ready && asset.kind !== 'audio'

  const remove = async () => {
    try {
      await api.deleteAsset(projectId, asset.id)
      useEditor.getState().removeAssetLocally(asset.id)
    } catch (e) {
      toast.error(e)
    }
    setConfirm(false)
  }

  return (
    <div
      draggable={asset.status !== 'error'}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_MIME, asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={() => {
        useEditor.getState().addAssetClip(asset)
        onAdded?.()
      }}
      className="group relative cursor-grab overflow-hidden rounded-lg border border-line bg-panel-2 transition-colors hover:border-line-strong active:cursor-grabbing"
      title={`${asset.original_name}\n${asset.width ? `${asset.width}×${asset.height} · ` : ''}${formatBytes(asset.size)}\nDouble-click, drag or press + to add`}
    >
      <div className="relative aspect-video bg-bg">
        {hasPoster ? (
          <ApiImg url={api.posterUrl(projectId, asset.id)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-faint">
            {asset.status === 'processing' ? (
              <Spinner size={16} />
            ) : asset.status === 'error' ? (
              <AlertTriangle size={18} className="text-danger" />
            ) : (
              <Music size={20} />
            )}
          </div>
        )}
        {asset.kind !== 'image' && asset.duration > 0 && (
          <span className="tabular absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px]">
            {formatDuration(asset.duration)}
          </span>
        )}
        {used > 0 && <span className="absolute top-1 left-1 h-1.5 w-1.5 rounded-full bg-accent" title="Used in timeline" />}
        <div className="absolute top-1 right-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
          {asset.status !== 'error' && (
            <IconButton
              label="Add at playhead"
              className="h-6! w-6! bg-black/70 pointer-coarse:h-8! pointer-coarse:w-8!"
              onClick={() => {
                useEditor.getState().addAssetClip(asset)
                onAdded?.()
              }}
            >
              <Plus size={13} />
            </IconButton>
          )}
          {asset.status === 'error' && (
            <IconButton
              label="Retry processing"
              className="h-6! w-6! bg-black/70 pointer-coarse:h-8! pointer-coarse:w-8!"
              onClick={async () => {
                try {
                  const a = await api.reprocessAsset(projectId, asset.id)
                  const s = useEditor.getState()
                  s.setAssets(s.assets.map((x) => (x.id === a.id ? a : x)))
                } catch (e) {
                  toast.error(e)
                }
              }}
            >
              <RotateCw size={12} />
            </IconButton>
          )}
          <IconButton label="Delete media" className="h-6! w-6! bg-black/70 pointer-coarse:h-8! pointer-coarse:w-8!" onClick={() => (used ? setConfirm(true) : remove())}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[11px]">
        <span className="text-faint">{kindIcon[asset.kind]}</span>
        <span className="truncate">{asset.original_name}</span>
      </div>
      {asset.status === 'error' && <div className="truncate px-2 pb-1.5 text-[10px] text-danger">{asset.error}</div>}

      {confirm && (
        <Modal
          title="Delete media?"
          onClose={() => setConfirm(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={remove}>
                Delete
              </Button>
            </>
          }
        >
          <p className="text-muted">
            “<span className="text-fg">{asset.original_name}</span>” is used by {used} clip{used === 1 ? '' : 's'} in the
            timeline. Those clips will be removed too.
          </p>
        </Modal>
      )}
    </div>
  )
}
