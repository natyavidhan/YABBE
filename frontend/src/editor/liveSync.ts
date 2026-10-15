/**
 * Live sync: the server announces every save of the project (Server-Sent
 * Events). Saves from elsewhere - another tab, or an AI agent through YABBE
 * MCP - are pulled into the open editor right away (one undo step each), and
 * this editor's saves only go through if nobody else saved in between (the
 * server checks the revision; see useAutosave), so neither side overwrites
 * the other.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { api, CLIENT_ID } from '../api/client'
import { useEditor } from './store'

interface Change {
  rev: number
  timeline?: boolean
  client?: string | null
}

/** Someone else editing right now (for the header): who, and until when to show it. */
export const useRemoteActivity = create<{ by: 'ai' | 'other' | null }>(() => ({ by: null }))
let clearTimer: number | undefined

function flashActivity(client: string | null | undefined) {
  useRemoteActivity.setState({ by: client?.startsWith('mcp') ? 'ai' : 'other' })
  window.clearTimeout(clearTimer)
  clearTimer = window.setTimeout(() => useRemoteActivity.setState({ by: null }), 4000)
}

export function useLiveSync(projectId: string) {
  useEffect(() => {
    let busy = false
    let again: Change | null = null
    let stopped = false

    const sync = async (ev: Change) => {
      if (ev.client === CLIENT_ID || stopped) return
      if (busy) {
        again = ev
        return
      }
      busy = true
      try {
        const p = await api.getProject(projectId)
        const s = useEditor.getState()
        if (s.projectId !== projectId || stopped) return
        s.setAssets(p.assets) // new uploads, processing done, ...
        if ((p.rev ?? 0) === s.rev) return
        if (s.gestureStart) {
          again = ev // mid-drag: take it once the drag ends
          return
        }
        // (unsaved edits here are merged on top, then saved)
        s.applyRemote(p)
        flashActivity(ev.client)
      } catch {
        /* offline for a moment: the next event or reconnect catches up */
      } finally {
        busy = false
        if (again && !stopped) {
          const next = again
          again = null
          window.setTimeout(() => sync(next), 300)
        }
      }
    }

    const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`)
    es.addEventListener('hello', (e) => {
      // (Re)connected: catch up on anything missed while disconnected.
      const d = JSON.parse((e as MessageEvent).data) as Change
      if (d.rev !== useEditor.getState().rev) void sync({ ...d, timeline: true, client: null })
    })
    es.addEventListener('change', (e) => void sync(JSON.parse((e as MessageEvent).data) as Change))
    return () => {
      stopped = true
      es.close()
    }
  }, [projectId])
}

/** After a save was refused because the project changed elsewhere: take the
 * new version with this editor's edits merged on top (autosave then saves it). */
export async function takeRemoteAfterConflict(projectId: string) {
  const p = await api.getProject(projectId)
  useEditor.getState().applyRemote(p)
  flashActivity(null)
}
