import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { audioInput, TRACK_CHOICES, tracksFor } from '../model/addTrack'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { AddTrackButton } from '../ui/AddTrack'
import { setActiveTool } from '../state/tools'
import { ToolBar } from '../ui/ToolBar'

describe('add track panel', () => {
  const base = { kind: 'audio' as const, count: 1, instrument: 'synth' as const, input: 'mic' as const, inputIndex: 1, channels: 1 as const, armed: false }

  it('offers four one-tap choices and a large Add Track button', () => {
    expect(TRACK_CHOICES.map((item) => `${item.name} (${item.detail})`)).toEqual([
      'Instrument (Play keys)',
      'Step Sequencer (Program beats)',
      'Beat Machine (Pads)',
      'Audio / Vocal (Record mic)',
    ])
    const store = new ProjectStore(createEmptyProject())
    const html = renderToStaticMarkup(createElement(AddTrackButton, { store, prominent: true }))
    expect(html).toContain('Add Track')
    expect(html).toContain('add-track-btn')
    expect(html).not.toContain('role="dialog"')
  })

  it('numbers the audio input and leaves other tracks disarmed', () => {
    const project = createEmptyProject()
    const made = tracksFor({ ...base, input: 'line', inputIndex: 2, channels: 2, armed: false }, project.tracks)
    expect(audioInput({ ...base, input: 'line', inputIndex: 2 })).toBe('line:1')
    expect(made[0].input).toBe('line:1')
    expect(made[0].armed).toBe(false)
    expect(made[0].channels).toBe(2)
    const kit = tracksFor({ ...base, kind: 'drum', instrument: '808' }, project.tracks)
    expect(kit[0].instrument).toBe('808')
    expect(kit[0].name).toBe('808 1')
  })
})

describe('tool panel', () => {
  it('names each tool and groups pick, edit, and view', () => {
    setActiveTool('pencil')
    const html = renderToStaticMarkup(createElement(ToolBar, {
      panel: true,
      context: 'arrange',
      onChange: () => undefined,
      onDuplicate: () => undefined,
      onDelete: () => undefined,
    }))
    expect(html).toContain('Pick and move')
    expect(html).toContain('>Edit<')
    expect(html).toContain('>View<')
    expect(html).toContain('Draw: tap a lane to add a clip')
    expect(html).toContain('>Duplicate<')
    expect(html).toContain('>Delete<')
    expect(html).toContain('aria-pressed="true"')
  })
})
