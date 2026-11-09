import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { TEMPO_DRAG_SLOP, tempoDragIntent, tempoFromDrag } from '../model/tempoDrag'
import { ProjectStore } from '../state/store'

describe('tempo drag', () => {
  it('treats a short press as a tap and a vertical move as a drag', () => {
    expect(tempoDragIntent(0, 0)).toBe('pending')
    expect(tempoDragIntent(TEMPO_DRAG_SLOP - 1, 2)).toBe('pending')
    expect(tempoDragIntent(0, TEMPO_DRAG_SLOP + 2)).toBe('drag')
    expect(tempoDragIntent(-(TEMPO_DRAG_SLOP + 4), 2)).toBe('scroll')
  })

  it('raises tempo when the finger moves up and clamps to 30–300', () => {
    expect(tempoFromDrag(120, 30)).toBe(123)
    expect(tempoFromDrag(120, -20)).toBe(118)
    expect(tempoFromDrag(120, 8)).toBe(121)
    expect(tempoFromDrag(120, 14)).toBe(121.4)
    expect(tempoFromDrag(120, 8, undefined, true)).toBe(120.2)
    expect(tempoFromDrag(120, 10000)).toBe(300)
    expect(tempoFromDrag(40, -10000)).toBe(30)
  })

  it('groups a drag into one undo and drops a cancelled drag that returns to the start', () => {
    const store = new ProjectStore(createEmptyProject())
    expect(store.project.tempo).toBe(120)
    store.setTempo(tempoFromDrag(120, 40), true)
    store.setTempo(tempoFromDrag(120, 80), true)
    store.endTempoGroup()
    expect(store.project.tempo).toBe(128)
    store.undo()
    expect(store.project.tempo).toBe(120)
    expect(store.canUndo).toBe(false)
    store.setTempo(tempoFromDrag(120, 50), true)
    store.setTempo(120, true)
    store.endTempoGroup()
    expect(store.project.tempo).toBe(120)
    expect(store.canUndo).toBe(false)
  })
})
