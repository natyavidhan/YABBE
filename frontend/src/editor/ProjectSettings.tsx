import { Button, Field, Modal, NumberInput, inputClass } from '../components/ui'
import { FPS_PRESETS, RESOLUTION_PRESETS } from '../lib/presets'
import { useEditor } from './store'

export function ProjectSettingsForm() {
  const settings = useEditor((s) => s.doc.settings)
  const update = useEditor((s) => s.updateSettings)
  const presetIndex = RESOLUTION_PRESETS.findIndex((p) => p.width === settings.width && p.height === settings.height)
  const even = (v: number) => Math.max(16, Math.round(v / 2) * 2)

  return (
    <div className="flex flex-col gap-3">
      <Field label="Canvas">
        <select
          className={`${inputClass} text-xs`}
          value={presetIndex}
          onChange={(e) => {
            const p = RESOLUTION_PRESETS[Number(e.target.value)]
            if (p) update({ width: p.width, height: p.height })
          }}
        >
          {presetIndex < 0 && <option value={-1}>Custom</option>}
          {RESOLUTION_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <NumberInput label="W" value={settings.width} onChange={(w) => update({ width: even(w) })} min={16} max={7680} step={2} precision={0} suffix="px" />
        <NumberInput label="H" value={settings.height} onChange={(h) => update({ height: even(h) })} min={16} max={4320} step={2} precision={0} suffix="px" />
      </div>
      <Field label="Frame rate" group>
        <div className="flex gap-1">
          {FPS_PRESETS.map((f) => (
            <button
              key={f}
              onClick={() => update({ fps: f })}
              className={`h-7 flex-1 rounded-md border text-xs transition-colors ${
                settings.fps === f ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:border-line-strong'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Background" group>
        <label className="flex h-8 items-center gap-2 rounded-md border border-line bg-bg px-2">
          <input
            type="color"
            value={settings.background}
            onChange={(e) => update({ background: e.target.value })}
            className="h-5 w-6 cursor-pointer border-0 bg-transparent p-0"
          />
          <span className="font-mono text-xs text-muted uppercase">{settings.background}</span>
        </label>
      </Field>
    </div>
  )
}

export function ProjectSettingsDialog({ onClose }: { onClose: () => void }) {
  const name = useEditor((s) => s.doc.sequences.find((x) => x.id === s.doc.active)?.name ?? '')
  return (
    <Modal
      title={`Sequence settings · ${name}`}
      onClose={onClose}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <ProjectSettingsForm />
      <p className="mt-3 text-xs text-faint">
        Positions are measured in canvas pixels from the centre, so changing the canvas size keeps layers centred but
        may crop or reveal edges.
      </p>
    </Modal>
  )
}
