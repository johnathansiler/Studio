import { describe, expect, it } from 'vitest'
import { phoneContextKind } from '../ui/phoneContext'

describe('phone context row', () => {
  it('uses the arrange row when nothing is selected and no sheet is open', () => {
    expect(phoneContextKind({ sheet: null, place: 'arrange', notes: false, clip: false, track: false })).toBe('arrange')
  })

  it('keeps Undo and the edit row when a track header is tapped', () => {
    expect(phoneContextKind({ sheet: null, place: 'arrange', notes: false, clip: false, track: false })).toBe('arrange')
    expect(phoneContextKind({ sheet: null, place: 'arrange', notes: false, clip: false, track: true })).toBe('arrange')
  })

  it('follows the open sheet, then the screen, then the selection', () => {
    expect(phoneContextKind({ sheet: 'menu', place: 'arrange', notes: false, clip: true, track: true })).toBe('menu')
    expect(phoneContextKind({ sheet: 'browse', place: 'mix', notes: false, clip: false, track: true })).toBe('browse')
    expect(phoneContextKind({ sheet: 'tools', place: 'arrange', notes: true, clip: true, track: true })).toBe('tools')
    expect(phoneContextKind({ sheet: null, place: 'mix', notes: false, clip: true, track: true })).toBe('mix')
    expect(phoneContextKind({ sheet: null, place: 'collab', notes: false, clip: false, track: false })).toBe('collab')
    expect(phoneContextKind({ sheet: null, place: 'plugin', notes: true, clip: false, track: false })).toBe('notes')
    expect(phoneContextKind({ sheet: null, place: 'plugin', notes: false, clip: false, track: false })).toBe('plugin')
    expect(phoneContextKind({ sheet: null, place: 'arrange', notes: false, clip: true, track: true })).toBe('arrange')
  })
})
