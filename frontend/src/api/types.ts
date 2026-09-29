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

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'color_burn'
  | 'linear_burn'
  | 'lighten'
  | 'screen'
  | 'color_dodge'
  | 'add'
  | 'overlay'
  | 'soft_light'
  | 'hard_light'
  | 'vivid_light'
  | 'linear_light'
  | 'pin_light'
  | 'hard_mix'
  | 'difference'
  | 'exclusion'
  | 'subtract'
  | 'divide'

export type TrackerKind = 'point' | 'transform' | 'corner_pin' | 'stabilize'

/** A motion tracker on a video clip. Coordinates are normalised to the source
 * frame (0..1), times are source seconds. */
export interface Tracker {
  id: string
  name: string
  kind: TrackerKind
  /** Source time the region was placed on. */
  ref: number
  /** cx, cy, w, h (point / transform). */
  box: [number, number, number, number]
  /** Corner pin: top-left, top-right, bottom-right, bottom-left. */
  quad: [number, number][]
  start: number | null
  end: number | null
  quality: 'fast' | 'precise'
}

export interface FollowTrack {
  clip_id: string
  tracker_id: string
  position: boolean
  rotation: boolean
  scale: boolean
}

export interface PinTrack {
  clip_id: string
  tracker_id: string
}

export interface Stabilize {
  tracker_id: string
  mode: 'smooth' | 'lock'
  smoothness: number
  rotation: boolean
  scale: boolean
  auto_zoom: boolean
}

export interface TrackStatus {
  tracker_id: string
  key: string
  state: 'done' | 'tracking' | 'queued' | 'error' | 'none'
  progress: number
  error: string | null
  job_id: string | null
}

/** Tracking result (engine/tracking.py). */
export interface TrackData {
  kind: TrackerKind
  fps: number
  times: number[]
  /** point / transform: [x, y, deg, scale, confidence]; corner pin: 4 x (x, y) + confidence. */
  samples?: number[][]
  /** stabilize: [dx, dy, deg, scale] per frame. */
  path?: number[][]
  ref?: number
}

/** Roto brush selection on one source frame (normalised source coordinates). */
export interface RotoPrompt {
  t: number
  box: [number, number, number, number] | null
  /** [x, y, label]: 1 = part of the object, 0 = not. */
  points: [number, number, number][]
}

export interface Roto {
  enabled: boolean
  prompts: RotoPrompt[]
  start: number | null
  end: number | null
  invert: boolean
  refine: boolean
  choke: number
  feather: number
  matte?: boolean
}

export interface RotoStatus {
  clip_id: string
  key: string
  state: 'done' | 'tracking' | 'queued' | 'error' | 'none'
  progress: number
  error: string | null
}

export interface ChromaKey {
  enabled: boolean
  /** The screen colour (#rrggbb). */
  color: string
  /** Matte levels: below clip_black is screen, above clip_white is solid subject. */
  clip_black: number
  clip_white: number
  /** Remove the screen's colour cast from the subject (0..1). */
  spill: number
  /** Shrink / soften the matte edge, in source pixels. */
  choke: number
  feather: number
  /** Preview only: render the matte instead. */
  matte?: boolean
}

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

export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'sequence'

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
export type Ease =
  | 'linear'
  | 'hold'
  | 'bezier'
  | 'ease_in'
  | 'ease_out'
  | 'ease_in_out'
  | 'back_in'
  | 'back_out'
  | 'back_in_out'
  | 'elastic_in'
  | 'elastic_out'
  | 'elastic_in_out'
  | 'bounce_in'
  | 'bounce_out'
  | 'bounce_in_out'

export type HandleMode = 'auto' | 'auto_clamped' | 'aligned' | 'free'

/** ``t`` is seconds from the clip's start; ``ease`` shapes the segment to the next key. */
export interface Keyframe {
  t: number
  v: number
  /** Colour value (#rrggbb[aa]) for colour properties. */
  c?: string | null
  /** Shape of the segment from this key to the next. */
  ease: Ease
  /** Bézier handles as [dt, dv] offsets from the key (incoming / outgoing). */
  hi?: [number, number] | null
  ho?: [number, number] | null
  hm?: HandleMode | null
  /** Ease parameters (back: overshoot; elastic: oscillations, decay). */
  ep?: number[] | null
}

/** A named point on a clip; ``t`` is seconds from the clip's start. */
export interface Marker {
  id: string
  t: number
  label: string
  color: string
}

/** Transition into the next clip that touches this one (centred on the cut). */
export interface Transition {
  kind: string
  duration: number
  /** Crossfade the two clips' sound over the transition (default on). */
  audio?: boolean
}

export interface TransitionInfo {
  id: string
  name: string
  category: string
}

export interface TransitionCatalog {
  categories: string[]
  transitions: TransitionInfo[]
  default_duration: number
  min_duration: number
  max_duration: number
}

export interface Clip {
  id: string
  track_id: string
  type: ClipType
  asset_id: string | null
  /** For type 'sequence': the nested sequence. */
  sequence_id?: string | null
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
  transition?: Transition | null
  /** How the picture combines with what's below it (default normal). */
  blend?: BlendMode
  /** The sound was separated into its own audio clip: this clip is silent. */
  audio_detached?: boolean
  chroma_key?: ChromaKey | null
  trackers?: Tracker[]
  follow?: FollowTrack | null
  pin?: PinTrack | null
  stabilize?: Stabilize | null
  roto?: Roto | null
  /** Clips sharing a link id are selected / moved / deleted together. */
  link?: string | null
}

/** One timeline with its own settings. */
export interface Sequence {
  id: string
  name: string
  settings: ProjectSettings
  tracks: Track[]
  clips: Clip[]
  created_at?: number
}

export interface Project {
  id: string
  name: string
  created_at: number
  updated_at: number
  assets: Asset[]
  sequences: Sequence[]
  main_sequence_id: string
  /** Make draft pre-renders of nested sequences in the background after edits. */
  auto_prerender?: boolean
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
  sequences?: Sequence[]
  main_sequence_id?: string
  /** For a single timeline's contents: which sequence they belong to. */
  sequence_id?: string
  settings?: ProjectSettings
  tracks?: Track[]
  clips?: Clip[]
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export type PrerenderQuality = 'draft' | 'preview' | 'full'

export interface PrerenderQualityStatus {
  quality: PrerenderQuality
  state: 'fresh' | 'stale' | 'queued' | 'rendering' | 'none'
  height: number
  size: number
  progress: number
  job_id: string | null
}

export interface SequenceRenderStatus {
  sequence_id: string
  /** Nested in another sequence. */
  used: boolean
  qualities: PrerenderQualityStatus[]
}

export interface StorageInfo {
  total: number
  used: number
  free: number
  /** Kept free for renders; uploads can't use it. */
  reserve: number
}

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
