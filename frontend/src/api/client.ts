import type {
  Asset,
  ExportRecord,
  Job,
  PreviewSession,
  PrerenderQuality,
  Project,
  ProjectSettings,
  ProjectSummary,
  Quality,
  SequenceRenderStatus,
  Roto,
  RotoPrompt,
  RotoStatus,
  StorageInfo,
  Tracker,
  TrackData,
  TrackStatus,
  TextStyle,
  Timeline,
  TransitionCatalog,
} from './types'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`
  try {
    const body = await res.json()
    if (typeof body?.detail === 'string') message = body.detail
    else if (Array.isArray(body?.detail)) message = body.detail.map((d: { msg: string }) => d.msg).join('; ')
  } catch {
    /* not json */
  }
  return new ApiError(res.status, message)
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw await errorFrom(res)
  return (await res.json()) as T
}

/** Upload raw bytes with progress (fetch has no upload progress). */
function uploadRaw<T>(url: string, file: Blob, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T)
      else {
        const detail = (body as { detail?: unknown } | null)?.detail
        const message =
          typeof detail === 'string'
            ? detail
            : xhr.status === 413
              ? 'This file is too big to upload through this link (tunnels like Cloudflare allow about 100 MB per file)'
              : `Upload failed (${xhr.status})`
        reject(new ApiError(xhr.status, message))
      }
    }
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'))
    xhr.send(file)
  })
}

const p = (id: string) => `/api/projects/${encodeURIComponent(id)}`

export const api = {
  // projects
  listProjects: () => request<ProjectSummary[]>('GET', '/api/projects'),
  createProject: (body: { name: string } & Partial<ProjectSettings>) =>
    request<Project>('POST', '/api/projects', body),
  getProject: (id: string) => request<Project>('GET', p(id)),
  saveProject: (id: string, timeline: Timeline) => request<Project>('PUT', p(id), timeline),
  deleteProject: (id: string) => request<{ ok: boolean }>('DELETE', p(id)),
  duplicateProject: (id: string) => request<Project>('POST', `${p(id)}/duplicate`),
  thumbnailUrl: (id: string, bust: number) => `${p(id)}/thumbnail?v=${bust}`,
  packageUrl: (id: string) => `${p(id)}/package`,
  importPackage: (file: File, onProgress?: (f: number) => void) =>
    uploadRaw<Project>('/api/projects/import', file, onProgress),

  // media
  uploadMedia: (id: string, file: File, onProgress?: (f: number) => void) =>
    uploadRaw<Asset>(`${p(id)}/media?filename=${encodeURIComponent(file.name)}`, file, onProgress),
  freezeFrame: (id: string, assetId: string, t: number) =>
    request<Asset>('POST', `${p(id)}/media/freeze`, { asset_id: assetId, t }),
  deleteAsset: (id: string, assetId: string) => request<{ ok: boolean }>('DELETE', `${p(id)}/media/${assetId}`),
  reprocessAsset: (id: string, assetId: string) => request<Asset>('POST', `${p(id)}/media/${assetId}/reprocess`),
  posterUrl: (id: string, assetId: string) => `${p(id)}/media/${assetId}/poster`,
  filmstripUrl: (id: string, assetId: string) => `${p(id)}/media/${assetId}/filmstrip`,
  waveformUrl: (id: string, assetId: string) => `${p(id)}/media/${assetId}/waveform`,

  // rendering
  async frame(id: string, t: number, height: number, timeline: Timeline, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(`${p(id)}/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t, height, timeline }),
      signal,
    })
    if (!res.ok) throw await errorFrom(res)
    return res.blob()
  },
  preview: (id: string, height: number, timeline: Timeline) =>
    request<PreviewSession>('POST', `${p(id)}/preview`, { height, timeline }),
  playlistUrl: (key: string) => `/api/preview/${key}/index.m3u8`,

  setAutoPrerender: (id: string, on: boolean) => request<Project>('PUT', p(id), { auto_prerender: on }),

  // pre-renders
  prerenders: (id: string) => request<SequenceRenderStatus[]>('GET', `${p(id)}/prerenders`),
  startPrerender: (id: string, sequenceId: string, quality: PrerenderQuality) =>
    request<Job | null>('POST', `${p(id)}/sequences/${encodeURIComponent(sequenceId)}/prerender`, { quality }),
  clearPrerender: (id: string, sequenceId: string, quality?: PrerenderQuality) =>
    request<{ ok: boolean }>(
      'DELETE',
      `${p(id)}/sequences/${encodeURIComponent(sequenceId)}/prerender${quality ? `?quality=${quality}` : ''}`,
    ),

  // exports
  listExports: (id: string) => request<ExportRecord[]>('GET', `${p(id)}/exports`),
  startExport: (id: string, options: { height: number | null; quality: Quality; sequence_id?: string }) =>
    request<{ export: ExportRecord; job: Job }>('POST', `${p(id)}/exports`, options),
  deleteExport: (id: string, exportId: string) => request<{ ok: boolean }>('DELETE', `${p(id)}/exports/${exportId}`),
  downloadExportUrl: (id: string, exportId: string) => `${p(id)}/exports/${exportId}/download`,

  // jobs
  listJobs: (projectId?: string) =>
    request<Job[]>('GET', `/api/jobs${projectId ? `?project_id=${encodeURIComponent(projectId)}` : ''}`),
  cancelJob: (jobId: string) => request<{ ok: boolean }>('POST', `/api/jobs/${jobId}/cancel`),

  // roto brush
  rotoInfo: () => request<{ available: boolean }>('GET', '/api/roto/info'),
  async rotoPreview(id: string, assetId: string, prompt: RotoPrompt, signal?: AbortSignal): Promise<Blob> {
    const res = await fetch(`${p(id)}/roto/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_id: assetId, prompt }),
      signal,
    })
    if (!res.ok) throw await errorFrom(res)
    return res.blob()
  },
  rotoRun: (id: string, item: { clip_id: string; asset_id: string; roto: Roto }) =>
    request<RotoStatus>('POST', `${p(id)}/roto/run`, item),
  rotoStatus: (id: string, items: { clip_id: string; asset_id: string; roto: Roto }[]) =>
    request<RotoStatus[]>('POST', `${p(id)}/roto/status`, items),

  // motion tracking
  trackingStatus: (id: string, items: { asset_id: string; tracker: Tracker }[]) =>
    request<TrackStatus[]>('POST', `${p(id)}/tracking/status`, items),
  trackingRun: (id: string, item: { asset_id: string; tracker: Tracker }) =>
    request<TrackStatus>('POST', `${p(id)}/tracking/run`, item),
  trackingResult: (id: string, key: string) => request<TrackData>('GET', `${p(id)}/tracking/result/${key}`),

  storage: () => request<StorageInfo>('GET', '/api/storage'),

  // transitions
  transitions: () => request<TransitionCatalog>('GET', '/api/transitions'),
  // ?v= matches the server's preview version so browsers never reuse an older cached copy.
  transitionPreviewUrl: (kind: string) => `/api/transitions/${encodeURIComponent(kind)}/preview.webp?v=2`,
  transitionPosterUrl: (kind: string) => `/api/transitions/${encodeURIComponent(kind)}/poster.jpg?v=2`,

  // text
  fonts: () => request<string[]>('GET', '/api/fonts'),
  measureText: (style: TextStyle, signal?: AbortSignal) =>
    request<{ width: number; height: number }>('POST', '/api/text/measure', style, signal),
}
