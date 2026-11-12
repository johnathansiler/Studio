import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { DeleteTrackConfirm, applyTrackDelete, arrangeEditTarget } from '../ui/equalGrid'

describe('arrange delete and duplicate', () => {
  it('copies a selected clip onto the same track just after it, and undo puts it back', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.drawRegion(track.id, 0, 48000)
    const original = track.clips[0]
    expect(arrangeEditTarget(store).kind).toBe('clip')
    store.duplicateArrangeClips()
    const clips = store.project.tracks.find((item) => item.id === track.id)!.clips
    expect(clips).toHaveLength(2)
    expect(clips[1].startSample).toBe(original.startSample + original.durationSamples)
    expect(clips[1].id).not.toBe(original.id)
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.clips).toHaveLength(1)
  })

  it('removes a selected clip without a confirm, and undo restores it', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.drawRegion(track.id, 0, 24000)
    const id = track.clips[0].id
    store.deleteArrangeClips()
    expect(store.project.tracks.find((item) => item.id === track.id)!.clips.some((clip) => clip.id === id)).toBe(false)
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track.id)!.clips.some((clip) => clip.id === id)).toBe(true)
  })

  it('copies a selected track below it with its clips and plugins, and undo removes the copy', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.drawRegion(track.id, 0, 24000)
    store.addPlugin(track.id, 'eq')
    store.selectTrack(track.id)
    store.selectedClipId = null
    store.selectedClipIds = []
    expect(arrangeEditTarget(store)).toMatchObject({ kind: 'track', id: track.id })
    const before = store.project.tracks.length
    store.duplicateTrack(track.id)
    expect(store.project.tracks).toHaveLength(before + 1)
    const copy = store.project.tracks[1]
    expect(copy.name).toBe(`${track.name} copy`)
    expect(copy.id).not.toBe(track.id)
    expect(copy.clips).toHaveLength(1)
    expect(copy.clips[0].id).not.toBe(track.clips[0].id)
    expect(copy.plugins).toHaveLength(track.plugins.length)
    expect(copy.plugins[0].id).not.toBe(track.plugins[0].id)
    expect(copy.plugins[0].pluginId).toBe(track.plugins[0].pluginId)
    expect(store.selectedTrackId).toBe(copy.id)
    store.undo()
    expect(store.project.tracks).toHaveLength(before)
    expect(store.project.tracks.some((item) => item.id === copy.id)).toBe(false)
  })

  it('does nothing when no clip and no track are selected', () => {
    const store = new ProjectStore(createEmptyProject())
    store.selectTrack(null)
    expect(arrangeEditTarget(store)).toEqual({ kind: 'none' })
    const before = store.project.tracks.length
    store.duplicateTrack('missing')
    expect(store.project.tracks).toHaveLength(before)
    expect(store.canUndo).toBe(false)
  })

  it('asks before deleting a track: Cancel keeps it and Delete removes it', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    const html = renderToStaticMarkup(createElement(DeleteTrackConfirm, {
      name: track.name,
      onChoose: (choice) => applyTrackDelete(store, track.id, choice),
    }))
    expect(html).toContain(`Delete track &quot;${track.name}&quot;?`)
    expect(html).toContain('>Cancel<')
    expect(html).toContain('class="eq-danger"')
    expect(html).toContain('>Delete<')
    expect(html).toContain('eq-grid')
    applyTrackDelete(store, track.id, 'cancel')
    expect(store.project.tracks.some((item) => item.id === track.id)).toBe(true)
    expect(store.canUndo).toBe(false)
    applyTrackDelete(store, track.id, 'delete')
    expect(store.project.tracks.some((item) => item.id === track.id)).toBe(false)
    store.undo()
    expect(store.project.tracks.some((item) => item.id === track.id)).toBe(true)
  })
})
