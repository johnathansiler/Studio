import { describe, expect, it } from 'vitest'
import { emptyOmni } from '../instruments/patch'
import { isSessionLink, isUntouchedEmpty, NEW_PROJECT, planLaunch, readTab, shouldKeepProject, TAB_LIVE, TAB_PROJECT } from '../model/launchProject'
import { createEmptyProject } from '../model/types'

function memory() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('fresh project launch', () => {
  it('treats a new tab as fresh and a reload of that tab as a restore', () => {
    const storage = memory()
    expect(readTab(storage)).toEqual({ reload: false, current: null })
    expect(storage.getItem(TAB_LIVE)).toBe('1')
    storage.setItem(TAB_PROJECT, 'prj_song')
    expect(readTab(storage)).toEqual({ reload: true, current: 'prj_song' })
  })

  it('opens a blank project on a fresh launch and restores on reload', () => {
    expect(planLaunch({ reload: false, search: '', current: null })).toBe('empty')
    expect(planLaunch({ reload: true, search: '', current: 'prj_song' })).toBe('restore')
    expect(planLaunch({ reload: true, search: '', current: null })).toBe('restore')
    expect(planLaunch({ reload: true, search: '', current: NEW_PROJECT })).toBe('empty')
  })

  it('keeps a session invite on a fresh launch', () => {
    expect(isSessionLink('?session=ab12')).toBe(true)
    expect(isSessionLink('https://cueharbor.app/?session=EEVEDR')).toBe(true)
    expect(isSessionLink('?session=')).toBe(false)
    expect(isSessionLink('?knock=1')).toBe(false)
    expect(planLaunch({ reload: false, search: '?session=ab12', current: null })).toBe('restore')
    expect(planLaunch({ reload: true, search: '?session=ab12', current: NEW_PROJECT })).toBe('restore')
  })

  it('does not keep an untouched empty project, and does keep any edit or audio', () => {
    const blank = createEmptyProject()
    expect(isUntouchedEmpty(blank)).toBe(true)
    expect(shouldKeepProject(blank, 0)).toBe(false)
    const named = createEmptyProject()
    named.name = 'Harbor'
    expect(shouldKeepProject(named)).toBe(true)
    const tempo = createEmptyProject()
    tempo.tempo = 90
    expect(isUntouchedEmpty(tempo)).toBe(false)
    const noted = createEmptyProject()
    noted.tracks[2].midiClips.push({
      id: 'midi',
      name: 'Keys',
      startBeat: 0,
      durationBeats: 4,
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }],
    })
    expect(shouldKeepProject(noted)).toBe(true)
    const recorded = createEmptyProject()
    expect(shouldKeepProject(recorded, 1)).toBe(true)
    const patched = createEmptyProject()
    patched.tracks[2].omniPatch = emptyOmni('Pad')
    expect(shouldKeepProject(patched)).toBe(true)
    const limited = createEmptyProject()
    limited.masterPlugins = [{ id: 'lim', pluginId: 'limiter', version: '1', enabled: false, wet: 1, sidechain: '', params: {} }]
    expect(isUntouchedEmpty(limited)).toBe(true)
  })
})
