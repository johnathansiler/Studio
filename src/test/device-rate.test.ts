import { describe, expect, it } from 'vitest'
import { contextAttempts } from '../audio/core/contextOptions'
import { ANDROID_HAL_RATE, contextSampleRate } from '../audio/core/driver'
import { clickEvents, medianGap, renderDeviceOutput } from '../audio/core/deviceResample'

function sine(freq: number, n: number, rate: number, amp = 0.5) {
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return data
}

describe('device output rate', () => {
  it('asks Android for 48 kHz and leaves every other device alone', () => {
    expect(contextSampleRate('android-chrome')).toBe(ANDROID_HAL_RATE)
    expect(contextSampleRate('ios-safari')).toBeUndefined()
    expect(contextSampleRate('desktop')).toBeUndefined()
    const android = contextAttempts('interactive', 'android-chrome')
    expect(android.slice(0, 4).every((item) => item.sampleRate === 48000)).toBe(true)
    expect(android.at(-1)?.sampleRate).toBeUndefined()
    expect(contextAttempts('interactive').some((item) => item.sampleRate != null)).toBe(false)
    expect(contextAttempts('interactive', 'desktop').some((item) => item.sampleRate != null)).toBe(false)
  })

  it('clicks once per 1024-frame callback when 44100 is played on a 48 kHz speaker', () => {
    const input = sine(55, 44100, 44100)
    const callback = 1024
    const mismatched = renderDeviceOutput(input, 44100, 48000, callback)
    const events = clickEvents(mismatched)
    const gap = medianGap(events)
    const perSec = events.length / (mismatched.length / 48000)
    expect(gap).toBeGreaterThan(980)
    expect(gap).toBeLessThan(1060)
    expect(perSec).toBeGreaterThan(40)
    expect(perSec).toBeLessThan(55)

    const matchedIn = sine(55, 48000, 48000)
    const matched = renderDeviceOutput(matchedIn, 48000, 48000, callback)
    expect(clickEvents(matched)).toEqual([])
  })
})
