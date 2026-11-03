import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { quartersPerBar } from '../model/time'
import type { SectionKind } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from '../ui/form'
import { GuideLayer } from '../ui/GuideLayer'
import '../ui/guideSheet.css'
import {
  AMOUNTS,
  FEELS,
  GENRES,
  LENGTHS,
  MOODS,
  ROLES,
  SCALE_CHOICES,
  STRUCTURES,
  briefFromProject,
  genreById,
  keyName,
  normalizeBrief,
  roleLabel,
  sectionEnergy,
  type RoleId,
  type UnstuckBrief,
} from './brief'
import { composeUnstuck } from './compose'
import type { ComposeContext, PlanSection, UnstuckJob } from './draft'
import { arrangementEnd, unstuckSpan } from './place'
import { complementLabel, complementRole, readClip } from './read'

interface Memory {
  job: UnstuckJob
  startBeat: number
  endBeat: number
}

export function UnstuckSheet({ store, engine, onClose }: { store: ProjectStore; engine: AudioEngine; onClose: () => void }) {
  const version = store.version
  const place = useFormFactor() === 'desk' ? 'pop' : 'sheet'
  const [brief, setBrief] = useState<UnstuckBrief>(() => briefFromProject(store.project))
  const [memory, setMemory] = useState<Memory | null>(null)
  const [sectionId, setSectionId] = useState('')
  const [rewriteRole, setRewriteRole] = useState<RoleId>('drums')
  const bar = Math.max(1, quartersPerBar(store.project.timeSignature))
  const picture = readClip(store.project, store.selectedMidiClipId, bar)
  const sections = (store.project.sections ?? []).filter((section) => section.durationBeats > 0)
  void version

  useEffect(() => () => engine.stopPreview(), [engine])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function patch(next: Partial<UnstuckBrief>) {
    setBrief((current) => normalizeBrief({ ...current, ...next }))
  }

  function chooseGenre(id: string) {
    const genre = genreById(id)
    setBrief((current) => normalizeBrief({
      ...current,
      genre: id,
      feel: genre.feel,
      tempoMin: genre.tempo[0],
      tempoMax: genre.tempo[1],
      scale: id === 'maqam' && !current.scale.startsWith('maqam') ? 'maqam-hijaz' : current.scale,
    }))
  }

  function write(job: UnstuckJob, again = false) {
    const seed = again ? (brief.seed + 1) >>> 0 : brief.seed
    const steered = normalizeBrief({ ...brief, seed })
    const ctx = contextFor(job, again)
    if ((job.action === 'vary' || job.action === 'continue' || job.action === 'complement') && !ctx.clip) {
      store.toast('Select a MIDI clip first.', 'warn')
      return
    }
    const draft = composeUnstuck(steered, job, ctx)
    if (!draft.tracks.length) {
      store.toast(draft.summary, 'warn')
      return
    }
    engine.stopPreview()
    store.writeUnstuck(draft)
    const bounds = boundsOf(draft)
    setMemory({ job, startBeat: bounds.start, endBeat: bounds.end })
    if (again) setBrief(steered)
  }

  function contextFor(job: UnstuckJob, again: boolean): ComposeContext {
    const span = unstuckSpan(store.project)
    const pictureNow = readClip(store.project, store.selectedMidiClipId, bar)
    const base = { barBeats: bar, replace: again, previousEnd: memory?.endBeat }
    if (job.action === 'vary' && pictureNow) {
      const start = again && memory ? memory.startBeat : pictureNow.startBeat + pictureNow.durationBeats
      const end = start + pictureNow.durationBeats
      return { ...base, startBeat: start, replace: again || hasClip('Unstuck Variation', start, end), previousEnd: end, clip: pictureNow }
    }
    if (job.action === 'continue' && pictureNow) {
      const start = again && memory ? memory.startBeat : pictureNow.startBeat + pictureNow.durationBeats
      const bars = job.bars === 'section' ? 8 : job.bars
      const end = start + bars * bar
      return { ...base, startBeat: start, replace: again || hasClip('Unstuck Continue', start, end), previousEnd: end, clip: pictureNow, afterKind: sectionKindAt(pictureNow.startBeat) }
    }
    if (job.action === 'complement' && pictureNow) {
      const end = pictureNow.startBeat + pictureNow.durationBeats
      const role = complementRole(pictureNow.role)
      return { ...base, startBeat: pictureNow.startBeat, replace: again || hasRole(role, pictureNow.startBeat, end), previousEnd: end, clip: pictureNow }
    }
    if (job.action === 'rewrite') {
      return { ...base, startBeat: job.startBeat, replace: true, previousEnd: job.startBeat + job.bars * bar }
    }
    if (job.action === 'full') {
      const start = span ? span.start : snap(arrangementEnd(store.project), bar)
      return { ...base, startBeat: start, replace: Boolean(span), previousEnd: span?.end }
    }
    if (job.action === 'next-section') {
      const start = span ? snap(span.end, bar) : snap(arrangementEnd(store.project), bar)
      const last = [...(store.project.sections ?? [])].reverse().find((section) => section.durationBeats > 0)
      return { ...base, startBeat: start, replace: false, afterKind: last?.kind }
    }
    const start = span ? span.start : snap(arrangementEnd(store.project), bar)
    const end = span?.end ?? start + bar
    const followed = job.action === 'part' ? plansBetween(start, end) : undefined
    const at = job.action === 'fill' || job.action === 'transition' ? Math.max(start, end - bar) : start
    const replaceRole = job.action === 'part' && span ? hasRole(job.role, start, end) : false
    const replaceFill = (job.action === 'fill' && hasClip('Unstuck Fill', at, at + bar))
      || (job.action === 'transition' && hasClip('Unstuck Transition', at, at + bar))
    return {
      ...base,
      startBeat: at,
      replace: replaceRole || replaceFill,
      previousEnd: job.action === 'fill' || job.action === 'transition' ? at + bar : span?.end,
      sections: followed,
    }
  }

  function plansBetween(start: number, end: number): PlanSection[] | undefined {
    const hits = (store.project.sections ?? []).filter((section) => section.durationBeats > 0 && section.startBeat >= start - 0.05 && section.startBeat < end - 0.05)
    if (hits.length < 2) return undefined
    return hits.map((section) => ({
      kind: section.kind,
      name: section.name,
      startBeat: section.startBeat,
      bars: Math.max(1, Math.round(section.durationBeats / bar)),
      energy: sectionEnergy(section.kind),
    }))
  }

  function hasClip(fragment: string, start: number, end: number) {
    return store.project.tracks.some((track) => track.midiClips.some((clip) => {
      if (!clip.name.includes(fragment)) return false
      const clipEnd = clip.startBeat + clip.durationBeats
      return clipEnd > start + 0.01 && clip.startBeat < end - 0.01
    }))
  }

  function hasRole(role: RoleId, start: number, end: number) {
    const label = roleLabel(role)
    return store.project.tracks.some((track) => track.midiClips.some((clip) => {
      if (!clip.name.startsWith('Unstuck ') || !clip.name.includes(label)) return false
      const clipEnd = clip.startBeat + clip.durationBeats
      return clipEnd > start + 0.01 && clip.startBeat < end - 0.01
    }))
  }

  function sectionKindAt(beat: number): SectionKind | undefined {
    return (store.project.sections ?? []).find((section) => beat >= section.startBeat - 0.05 && beat < section.startBeat + Math.max(section.durationBeats, 0.01))?.kind
  }

  function rewriteSection() {
    const section = sections.find((item) => item.id === sectionId) ?? sections[0]
    if (!section) return
    const bars = Math.max(1, Math.round(section.durationBeats / bar))
    write({ action: 'rewrite', roles: brief.parts, kind: section.kind, name: section.name, bars, startBeat: section.startBeat })
  }

  function rewriteOne() {
    const section = sections.find((item) => item.id === sectionId)
    if (!section) {
      write({ action: 'part', role: rewriteRole })
      return
    }
    const bars = Math.max(1, Math.round(section.durationBeats / bar))
    write({ action: 'rewrite', roles: [rewriteRole], kind: section.kind, name: section.name, bars, startBeat: section.startBeat })
  }

  function togglePart(role: RoleId) {
    const has = brief.parts.includes(role)
    const parts = has ? brief.parts.filter((item) => item !== role) : [...brief.parts, role]
    patch({ parts: parts.length ? parts : [role] })
  }

  function toggleLock(role: RoleId) {
    const locks = brief.locks.includes(role) ? brief.locks.filter((item) => item !== role) : [...brief.locks, role]
    patch({ locks })
  }

  return (
    <GuideLayer>
      <div className={`guide-sheet unstuck-sheet unstuck-dock ${place}`} role="dialog" aria-label="Unstuck" data-unstuck="open">
        {place === 'sheet' && <div className="guide-handle" aria-hidden="true" />}
        <header className="guide-head">
          <div>
            <h2>Unstuck</h2>
            <p>Pick one part. Full song always writes two verses and two choruses, then any extra sections the seed keeps. Shuffle again keeps the locks.</p>
          </div>
          <button type="button" className="guide-x" onClick={onClose} aria-label="Close Unstuck">Close</button>
        </header>
        <div className="unstuck-grid" data-unstuck="parts">
          {ROLES.map((role) => (
            <button key={role.id} type="button" data-unstuck-action={role.id} onClick={() => write({ action: 'part', role: role.id })}>
              {role.name}
            </button>
          ))}
          <button type="button" data-unstuck-action="fill" onClick={() => write({ action: 'fill' })}>Fill</button>
          <button type="button" data-unstuck-action="transition" onClick={() => write({ action: 'transition' })}>Transition</button>
          <button type="button" data-unstuck-action="next-section" onClick={() => write({ action: 'next-section' })}>Next section</button>
        </div>
        {picture ? (
          <section className="guide-section" data-unstuck="clip">
            <h3>Selected clip</h3>
            <p className="guide-note">{picture.name}. {picture.bars} bars. Continue writes after it. Variation keeps this clip.</p>
            <div className="unstuck-grid">
              <button type="button" data-unstuck-action="continue-4" onClick={() => write({ action: 'continue', bars: 4 })}>Continue 4 bars</button>
              <button type="button" data-unstuck-action="continue-8" onClick={() => write({ action: 'continue', bars: 8 })}>Continue 8 bars</button>
              <button type="button" data-unstuck-action="continue-section" onClick={() => write({ action: 'continue', bars: 'section' })}>Continue section</button>
              <button type="button" data-unstuck-action="vary" onClick={() => write({ action: 'vary' })}>Variation</button>
              <button type="button" data-unstuck-action="complement" onClick={() => write({ action: 'complement' })}>{complementLabel(picture.role)}</button>
            </div>
            <div className="unstuck-grid" role="group" aria-label="Variation amount">
              {AMOUNTS.map((amount) => (
                <button key={amount.id} type="button" className={brief.amount === amount.id ? 'on' : ''} aria-pressed={brief.amount === amount.id} onClick={() => patch({ amount: amount.id })}>
                  {amount.name}
                </button>
              ))}
            </div>
          </section>
        ) : (
          <p className="guide-note">Select a MIDI clip to continue it, vary it, or add the part it is missing.</p>
        )}
        <div className="unstuck-grid">
          <button type="button" className="primary full-song" data-unstuck-action="full" onClick={() => write({ action: 'full' })}>Full song</button>
          <button type="button" data-unstuck-action="shuffle" disabled={!memory} onClick={() => memory && write(memory.job, true)}>Shuffle again</button>
        </div>
        <p className="guide-note">Seed {brief.seed}. {keyName(brief.key)} {scaleLabel(brief.scale)}. {genreById(brief.genre).name}.</p>
        <section className="guide-section" data-unstuck="steer">
          <h3>Steering</h3>
          <label className="steer-field">
            <span>Genre</span>
            <select aria-label="Genre" value={brief.genre} onChange={(event) => chooseGenre(event.target.value)}>
              {GENRES.map((genre) => <option key={genre.id} value={genre.id}>{genre.name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Feel</span>
            <select aria-label="Feel" value={brief.feel} onChange={(event) => patch({ feel: event.target.value as UnstuckBrief['feel'] })}>
              {FEELS.map((feel) => <option key={feel.id} value={feel.id}>{feel.name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Mood</span>
            <select aria-label="Mood" value={brief.mood} onChange={(event) => patch({ mood: event.target.value as UnstuckBrief['mood'] })}>
              {MOODS.map((mood) => <option key={mood.id} value={mood.id}>{mood.name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Energy {brief.energy.toFixed(2)}</span>
            <input aria-label="Energy" type="range" min={0} max={1} step={0.01} value={brief.energy} onChange={(event) => patch({ energy: Number(event.target.value) })} />
          </label>
          <div className="unstuck-grid">
            <label className="steer-field">
              <span>Tempo from</span>
              <input aria-label="Tempo from" type="number" min={40} max={240} value={brief.tempoMin} onChange={(event) => patch({ tempoMin: Number(event.target.value) })} />
            </label>
            <label className="steer-field">
              <span>Tempo to</span>
              <input aria-label="Tempo to" type="number" min={40} max={240} value={brief.tempoMax} onChange={(event) => patch({ tempoMax: Number(event.target.value) })} />
            </label>
          </div>
          <label className="steer-field">
            <span>Key</span>
            <select aria-label="Key" value={brief.key} onChange={(event) => patch({ key: Number(event.target.value) })}>
              {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Scale</span>
            <select aria-label="Scale" value={brief.scale} onChange={(event) => patch({ scale: event.target.value })}>
              {SCALE_CHOICES.map((scale) => <option key={scale.id} value={scale.id}>{scale.name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Complexity {brief.complexity.toFixed(2)}</span>
            <input aria-label="Complexity" type="range" min={0} max={1} step={0.01} value={brief.complexity} onChange={(event) => patch({ complexity: Number(event.target.value) })} />
          </label>
          <label className="steer-field">
            <span>Density {brief.density.toFixed(2)}</span>
            <input aria-label="Density" type="range" min={0} max={1} step={0.01} value={brief.density} onChange={(event) => patch({ density: Number(event.target.value) })} />
          </label>
          <label className="steer-field">
            <span>Humanize {brief.humanize.toFixed(2)}</span>
            <input aria-label="Humanize" type="range" min={0} max={1} step={0.01} value={brief.humanize} onChange={(event) => patch({ humanize: Number(event.target.value) })} />
          </label>
          <label className="steer-field">
            <span>Song length</span>
            <select aria-label="Song length" value={brief.length} onChange={(event) => patch({ length: event.target.value as UnstuckBrief['length'] })}>
              {LENGTHS.map((length) => <option key={length.id} value={length.id}>{length.name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Structure</span>
            <select aria-label="Structure" value={brief.structure} onChange={(event) => patch({ structure: event.target.value as UnstuckBrief['structure'] })}>
              {STRUCTURES.map((structure) => <option key={structure.id} value={structure.id}>{structure.name}</option>)}
            </select>
          </label>
          <label className="steer-field">
            <span>Seed</span>
            <input aria-label="Seed" type="number" min={0} step={1} value={brief.seed} onChange={(event) => patch({ seed: Number(event.target.value) })} />
          </label>
          <div className="unstuck-locks" role="group" aria-label="Instrumentation">
            {ROLES.map((role) => (
              <div key={role.id} className="unstuck-lock">
                <button type="button" className={brief.parts.includes(role.id) ? 'on' : ''} aria-pressed={brief.parts.includes(role.id)} onClick={() => togglePart(role.id)}>
                  Include {role.name}
                </button>
                <button type="button" className={brief.locks.includes(role.id) ? 'on' : ''} aria-pressed={brief.locks.includes(role.id)} onClick={() => toggleLock(role.id)}>
                  Lock {role.name}
                </button>
              </div>
            ))}
          </div>
        </section>
        {sections.length > 0 && (
          <section className="guide-section">
            <h3>Again, one piece</h3>
            <label className="steer-field">
              <span>Section</span>
              <select aria-label="Section" value={sectionId || sections[0].id} onChange={(event) => setSectionId(event.target.value)}>
                {sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
              </select>
            </label>
            <div className="unstuck-grid">
              <button type="button" data-unstuck-action="rewrite-section" onClick={rewriteSection}>Regenerate section</button>
              <label className="steer-field">
                <span>Part</span>
                <select aria-label="Part to regenerate" value={rewriteRole} onChange={(event) => setRewriteRole(event.target.value as RoleId)}>
                  {ROLES.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                </select>
              </label>
              <button type="button" data-unstuck-action="rewrite-part" onClick={rewriteOne}>Regenerate part</button>
            </div>
          </section>
        )}
      </div>
    </GuideLayer>
  )
}

function boundsOf(draft: { tracks: { clips: { startBeat: number; durationBeats: number }[] }[]; replace?: { endBeat: number } }) {
  let start = Infinity
  let end = 0
  for (const track of draft.tracks) {
    for (const clip of track.clips) {
      start = Math.min(start, clip.startBeat)
      end = Math.max(end, clip.startBeat + clip.durationBeats)
    }
  }
  if (draft.replace) end = Math.max(end, draft.replace.endBeat)
  return { start: Number.isFinite(start) ? start : 0, end }
}

function snap(beat: number, bar: number) {
  return Math.max(0, Math.round(beat / bar) * bar)
}

function scaleLabel(id: string) {
  return SCALE_CHOICES.find((scale) => scale.id === id)?.name ?? id
}
