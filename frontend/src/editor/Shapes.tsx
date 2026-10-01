import { Circle, Hexagon, Minus, MoveRight, Shapes as ShapesIcon, Square, Star, Triangle } from 'lucide-react'
import { useState } from 'react'
import type { AnimProp, Clip, ShapeKind, ShapeStyle } from '../api/types'
import { framesOf, shapeStyleAt } from './keyframes'
import { ContextMenu } from '../components/ContextMenu'
import { Section } from '../components/Section'
import { Button, NumberInput } from '../components/ui'
import { DEFAULT_SHAPE, useEditor, type ClipPatch } from './store'

export const SHAPES: { kind: ShapeKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'rectangle', label: 'Rectangle', icon: <Square size={13} /> },
  { kind: 'ellipse', label: 'Ellipse', icon: <Circle size={13} /> },
  { kind: 'triangle', label: 'Triangle', icon: <Triangle size={13} /> },
  { kind: 'polygon', label: 'Polygon', icon: <Hexagon size={13} /> },
  { kind: 'star', label: 'Star', icon: <Star size={13} /> },
  { kind: 'line', label: 'Line', icon: <Minus size={13} /> },
  { kind: 'arrow', label: 'Arrow', icon: <MoveRight size={13} /> },
]

/** "Shape" button with a menu of shapes to add at the playhead. */
export function AddShapeButton({ onAdded }: { onAdded?: () => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        title="Add a shape"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu({ x: r.left, y: r.bottom + 4 })
        }}
      >
        <ShapesIcon size={13} /> Shape
      </Button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={SHAPES.map((s) => ({
            label: s.label,
            icon: s.icon,
            onSelect: () => {
              useEditor.getState().addShapeClip(s.kind)
              onAdded?.()
            },
          }))}
        />
      )}
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-2">
      <span className="text-xs text-muted">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Colour swatch with an on/off switch (fill / outline can be turned off). */
function OptionalColor({ value, fallback, onChange, label }: { value: string | null; fallback: string; onChange: (v: string | null) => void; label: string }) {
  const { beginGesture, endGesture } = useEditor.getState()
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="checkbox"
        checked={value !== null}
        onChange={(e) => onChange(e.target.checked ? fallback : null)}
        className="accent-accent"
        aria-label={`${label} on`}
      />
      <label className={`flex h-7 flex-1 items-center gap-1.5 rounded-md border border-line bg-bg px-1.5 ${value === null ? 'opacity-40' : ''}`}>
        <input
          type="color"
          value={(value ?? fallback).slice(0, 7)}
          disabled={value === null}
          onPointerDown={beginGesture}
          onBlur={endGesture}
          onChange={(e) => onChange(e.target.value)}
          className="h-4 w-5 cursor-pointer border-0 bg-transparent p-0"
          aria-label={label}
        />
        <span className="font-mono text-[11px] text-muted uppercase">{value === null ? 'none' : value.slice(0, 7)}</span>
      </label>
    </div>
  )
}

export function ShapeSection({ clip, set, keyBtn, locked }: {
  clip: Clip
  set: (p: ClipPatch) => void
  /** ◆ keyframe button for an animatable property */
  keyBtn: (p: AnimProp) => React.ReactNode
  locked: boolean
}) {
  const playhead = useEditor((st) => st.playhead)
  // Values at the playhead (animated ones auto-key when edited).
  const s: ShapeStyle = { ...DEFAULT_SHAPE, ...(shapeStyleAt(clip, playhead) ?? clip.shape) }
  const upd = (p: Partial<ShapeStyle>) => set({ shape: { ...DEFAULT_SHAPE, ...clip.shape, ...p } })
  const setP = (values: Partial<Record<AnimProp, number | string | null>>) => {
    if (!locked) useEditor.getState().setProps(clip.id, values)
  }
  const setColor = (prop: 'shape_fill' | 'shape_stroke', v: string | null) => {
    if (locked) return
    // turning a colour off can't be a keyframe: it stops animating
    if (v === null && framesOf(clip, prop)) useEditor.getState().clearKeys(clip.id, prop)
    setP({ [prop]: v })
  }
  const line = s.kind === 'line' || s.kind === 'arrow'
  return (
    <Section icon={<ShapesIcon size={14} />} title="Shape">
      <div className="grid grid-cols-7 gap-1">
        {SHAPES.map((k) => (
          <button
            key={k.kind}
            type="button"
            title={k.label}
            aria-label={k.label}
            aria-pressed={s.kind === k.kind}
            onClick={() => upd({ kind: k.kind })}
            className={`flex h-7 items-center justify-center rounded-md border ${
              s.kind === k.kind ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg'
            }`}
          >
            {k.icon}
          </button>
        ))}
      </div>
      {(['width', 'height'] as const).map((dim) => (
        <Row key={dim} label={dim === 'width' ? 'Width' : 'Height'}>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NumberInput
                label={dim === 'width' ? 'W' : 'H'}
                value={Math.round(s[dim])}
                min={1}
                max={8000}
                step={1}
                precision={0}
                suffix="px"
                onChange={(v) => setP({ [`shape_${dim}`]: v })}
              />
            </div>
            {keyBtn(`shape_${dim}`)}
          </div>
        </Row>
      ))}
      {!line && (
        <Row label="Fill">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <OptionalColor label="Fill colour" value={s.fill} fallback="#7c5cff" onChange={(v) => setColor('shape_fill', v)} />
            </div>
            {s.fill !== null && keyBtn('shape_fill')}
          </div>
        </Row>
      )}
      <Row label={line ? 'Colour' : 'Outline'}>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <OptionalColor
              label={line ? 'Line colour' : 'Outline colour'}
              value={s.stroke}
              fallback="#ffffff"
              onChange={(v) => {
                setColor('shape_stroke', v)
                if (v && !s.stroke_width) setP({ shape_stroke_width: 8 })
              }}
            />
          </div>
          {s.stroke !== null && keyBtn('shape_stroke')}
        </div>
      </Row>
      {s.stroke !== null && (
        <Row label={line ? 'Thickness' : 'Outline width'}>
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NumberInput value={Math.round(s.stroke_width)} min={0} max={500} step={1} precision={0} suffix="px" onChange={(v) => setP({ shape_stroke_width: v })} />
            </div>
            {keyBtn('shape_stroke_width')}
          </div>
        </Row>
      )}
      {s.kind === 'rectangle' && (
        <Row label="Corners">
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <NumberInput value={Math.round(s.radius * 200)} min={0} max={100} step={1} precision={0} suffix="%" onChange={(v) => setP({ shape_radius: v / 200 })} />
            </div>
            {keyBtn('shape_radius')}
          </div>
        </Row>
      )}
      {(s.kind === 'polygon' || s.kind === 'star') && (
        <Row label={s.kind === 'star' ? 'Points' : 'Sides'}>
          <NumberInput value={s.sides} min={3} max={24} step={1} precision={0} onChange={(sides) => upd({ sides: Math.round(sides) })} />
        </Row>
      )}
      {s.kind === 'star' && (
        <Row label="Depth">
          <NumberInput value={Math.round((1 - s.inner) * 100)} min={5} max={95} step={1} precision={0} suffix="%" onChange={(v) => upd({ inner: 1 - v / 100 })} />
        </Row>
      )}
      <p className="text-[11px] text-faint">◆ animates a property over time. Move, scale, rotate and fade it in Transform below.</p>
    </Section>
  )
}
