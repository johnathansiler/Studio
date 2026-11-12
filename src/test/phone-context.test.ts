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

  it('keeps the edit row when a sheet is open or a track is selected', () => {
    expect(phoneContextKind({ sheet: 'menu', place: 'arrange', notes: false, clip: true, track: true })).toBe('arrange')
    expect(phoneContextKind({ sheet: 'browse', place: 'arrange', notes: false, clip: false, track: true })).toBe('arrange')
    expect(phoneContextKind({ sheet: 'tools', place: 'arrange', notes: true, clip: true, track: true })).toBe('arrange')
    expect(phoneContextKind({ sheet: 'browse', place: 'mix', notes: false, clip: false, track: true })).toBe('mix')
    expect(phoneContextKind({ sheet: null, place: 'mix', notes: false, clip: true, track: true })).toBe('mix')
    expect(phoneContextKind({ sheet: null, place: 'collab', notes: false, clip: false, track: false })).toBe('collab')
    expect(phoneContextKind({ sheet: null, place: 'plugin', notes: true, clip: false, track: false })).toBe('notes')
    expect(phoneContextKind({ sheet: null, place: 'plugin', notes: false, clip: false, track: false })).toBe('plugin')
    expect(phoneContextKind({ sheet: null, place: 'arrange', notes: false, clip: true, track: true })).toBe('arrange')
  })
})
