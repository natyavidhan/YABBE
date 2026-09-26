// Mirrors backend/app/models.py

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  background: string
}

export type AssetKind = 'video' | 'audio' | 'image'

export interface Asset {
  id: string
  kind: AssetKind
  filename: string
  original_name: string
  size: number
  duration: number
  width: number
  height: number
  fps: number
  has_video: boolean
  has_audio: boolean
  status: 'processing' | 'ready' | 'error'
  error: string | null
  thumb_count: number
  thumb_interval: number
  created_at: number
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  hidden: boolean
  locked: boolean
}

export interface Transform {
  x: number
  y: number
  scale: number
  rotation: number
  opacity: number
  flip_h: boolean
  flip_v: boolean
}

export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export interface TextStyle {
  content: string
  font: string
  size: number
  color: string
  background: string | null
  padding: number
  stroke_color: string
  stroke_width: number
  align: 'left' | 'center' | 'right'
  bold: boolean
  italic: boolean
  line_spacing: number
}

export type ClipType = 'video' | 'audio' | 'image' | 'text'

export type AnimProp =
  | 'x'
  | 'y'
  | 'scale'
  | 'rotation'
  | 'opacity'
  | 'volume'
  | 'text_size'
  | 'text_stroke_width'
  | 'text_padding'
  | 'text_line_spacing'
  | 'text_color'
  | 'text_stroke_color'
  | 'text_background'
export type Ease = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out' | 'hold'

/** ``t`` is seconds from the clip's start; ``ease`` shapes the segment to the next key. */
export interface Keyframe {
  t: number
  v: number
  /** Colour value (#rrggbb[aa]) for colour properties. */
  c?: string | null
  ease: Ease
}

/** A named point on a clip; ``t`` is seconds from the clip's start. */
export interface Marker {
  id: string
  t: number
  label: string
  color: string
}

export interface Clip {
  id: string
  track_id: string
  type: ClipType
  asset_id: string | null
  start: number
  duration: number
  in_point: number
  speed: number
  volume: number
  muted: boolean
  fade_in: number
  fade_out: number
  transform: Transform
  crop: Crop
  text: TextStyle | null
  keyframes: Partial<Record<AnimProp, Keyframe[]>>
  markers: Marker[]
}

export interface Project {
  id: string
  name: string
  created_at: number
  updated_at: number
  settings: ProjectSettings
  assets: Asset[]
  tracks: Track[]
  clips: Clip[]
}

export interface ProjectSummary {
  id: string
  name: string
  created_at: number
  updated_at: number
  duration: number
  width: number
  height: number
  asset_count: number
  has_thumbnail: boolean
}

export interface Timeline {
  name?: string
  settings?: ProjectSettings
  tracks?: Track[]
  clips?: Clip[]
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface Job {
  id: string
  kind: string
  project_id: string | null
  label: string
  status: JobStatus
  progress: number
  message: string
  error: string | null
  result: Record<string, unknown> | null
  created_at: number
  finished_at: number | null
}

export interface PreviewSession {
  key: string
  height: number
  segment: number
  count: number
  duration: number
}

export type Quality = 'high' | 'medium' | 'low'

export interface ExportRecord {
  id: string
  filename: string
  name: string
  status: 'rendering' | 'done' | 'error' | 'cancelled'
  job_id: string | null
  width: number
  height: number
  duration: number
  size: number
  quality: Quality
  error: string | null
  created_at: number
}
