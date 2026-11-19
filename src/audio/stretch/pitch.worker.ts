import { formantPitchChannels } from './formantPitch'

interface PitchRequest {
  id: number
  channels: Float32Array[]
  sampleRate: number
  semitones: number
  cents: number
  formant: boolean
}

const scope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<PitchRequest>) => void) | null
  postMessage: (data: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = (event) => {
  const message = event.data
  if (!message || typeof message.id !== 'number') return
  try {
    const channels = formantPitchChannels(message.channels ?? [], message.sampleRate, {
      semitones: message.semitones,
      cents: message.cents,
      formant: message.formant,
    })
    const transfer = channels.map((channel) => channel.buffer)
    scope.postMessage({ id: message.id, channels }, transfer)
  } catch (error) {
    const text = error instanceof Error ? error.message : 'Pitch shift failed'
    scope.postMessage({ id: message.id, error: text })
  }
}
