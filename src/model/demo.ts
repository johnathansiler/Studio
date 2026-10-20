/** A small drum-and-bass loop so Arrange has something to play before a mic is armed. */
export function renderDemoLoop(sampleRate: number, bars = 4, tempo = 120): Float32Array {
  const seconds = ((60 / tempo) * 4 * bars)
  const n = Math.floor(sampleRate * seconds)
  const data = new Float32Array(n)
  const beat = (60 / tempo) * sampleRate
  for (let i = 0; i < n; i++) {
    const beatPos = (i % beat) / beat
    const barBeat = Math.floor(i / beat) % 4
    // kick on 1 and 3, soft on the and-of-2
    if (barBeat === 0 || barBeat === 2) {
      const env = Math.exp(-beatPos * 8)
      data[i] += Math.sin(2 * Math.PI * (70 + (1 - beatPos) * 40) * (i / sampleRate)) * env * 0.55
    }
    // hats
    const eighth = beat / 2
    const hatPos = (i % eighth) / eighth
    if (hatPos < 0.08) {
      const noise = (hash(i) - 0.5) * 2
      data[i] += noise * (1 - hatPos / 0.08) * 0.12
    }
    // bass pulse
    const freq = barBeat === 3 ? 98 : 82
    const bassEnv = Math.exp(-((i % beat) / beat) * 3)
    data[i] += Math.sin(2 * Math.PI * freq * (i / sampleRate)) * bassEnv * 0.22
    data[i] = Math.max(-1, Math.min(1, data[i]))
  }
  return data
}

export function demoMidiNotes(): { pitch: number; startBeat: number; durationBeats: number; velocity: number }[] {
  const chord = [60, 64, 67, 71]
  const notes = []
  for (let bar = 0; bar < 2; bar++) {
    for (const pitch of chord) {
      notes.push({ pitch, startBeat: bar * 4, durationBeats: 1.5, velocity: 0.7 })
    }
    notes.push({ pitch: 72, startBeat: bar * 4 + 2, durationBeats: 0.5, velocity: 0.55 })
    notes.push({ pitch: 74, startBeat: bar * 4 + 2.5, durationBeats: 0.5, velocity: 0.5 })
    notes.push({ pitch: 76, startBeat: bar * 4 + 3, durationBeats: 0.75, velocity: 0.6 })
  }
  return notes
}

export function computePeaks(data: Float32Array, buckets: number): { min: number; max: number }[] {
  const count = Math.max(1, buckets)
  const out: { min: number; max: number }[] = []
  const size = data.length / count
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * size)
    const end = Math.max(start + 1, Math.floor((i + 1) * size))
    let min = 0
    let max = 0
    for (let j = start; j < end && j < data.length; j++) {
      const v = data[j]
      if (v < min) min = v
      if (v > max) max = v
    }
    out.push({ min, max })
  }
  return out
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}
