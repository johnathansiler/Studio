# Instrument control audit

Offline renders check each control at the low end, the default, and the top of its range. Parameter ids are unchanged, so factory and user presets still load. No preset migration was required.

The shared helper is `src/test/helpers/dsp-measure.ts`. Tests live in `src/test/controls-instruments.test.ts`.

| control | label | function | status | test |
| --- | --- | --- | --- | --- |
| sampler.root | Root | Note that plays the sample at its recorded pitch | ok | follows the root note |
| sampler.attack | Attack | Amplitude fade-in, milliseconds | ok | sets attack, decay, sustain, release, and gain |
| sampler.decay | Decay | Fall from the peak toward sustain | ok | sets attack, decay, sustain, release, and gain |
| sampler.sustain | Sustain | Level held while the note is down | ok | sets attack, decay, sustain, release, and gain |
| sampler.release | Release | Fade after the note ends | ok | sets attack, decay, sustain, release, and gain |
| sampler.cutoff | Tone | Low-pass brightness | ok | opens and closes the tone filter |
| sampler.loopMode | Loop / Ping / Once | Forward loop, ping-pong, or play once | ok | loops until once is selected |
| sampler.gain | Gain | Output level | ok | sets attack, decay, sustain, release, and gain |
| sampler.pitch | Pitch | Transpose. Stretch keeps the length; off, the length changes with the pitch | fixed | raises pitch by 12 semitones; keeps the length when stretch is on |
| library.tune | Tune / Root | Semitone shift of a multi-sample instrument, or the root of a one-zone instrument | ok | tunes in semitones |
| library.attack | Attack | Amplitude fade-in, seconds | ok | shapes the envelope and the tone |
| library.decay | Decay | Fall toward sustain | ok | shapes the envelope and the tone |
| library.sustain | Sustain | Held level | ok | shapes the envelope and the tone |
| library.release | Release | Fade after note-off | ok | shapes the envelope and the tone |
| library.tone | Tone | Low-pass brightness | ok | shapes the envelope and the tone |
| library.loop | Loop / Once | Loop each zone, or play it once. A zone with no loop points loops the whole sample | fixed | loops the zone when Loop is on |
| pad.tune | Pad tune | Semitone pitch. Vinyl also changes length | ok | doubles the frequency at +12 |
| pad.tuneCents | Pad cents | Fine pitch | ok | moves fine pitch by the cents knob |
| pad.pitchMode | Vinyl / Stretch | Vinyl changes speed and pitch together. Stretch keeps the length | ok | doubles the frequency at +12 and keeps the length in stretch |
| pad.filter | Filter | Low-pass cutoff | ok | high-pass and low-pass follow their knobs |
| pad.highpass | Pad high pass | Removes bass | ok | high-pass and low-pass follow their knobs |
| vintage.bits | Bit depth | Quantizes the pad. The top of the knob reaches 4-bit. SP-1200 stays about 13-bit | fixed | bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass |
| vintage.rate | Sample-rate reduction | Sample-and-hold. Any amount above zero holds at 24 kHz. The top of the knob falls to 4 kHz and aliases above that Nyquist. SP-1200 stays at the 24 kHz hold | fixed | bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass |
| vintage.wow | Tape wow and flutter | Slow pitch wobble | ok | bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass |
| vintage.crackle | Vinyl noise and crackle | Clicks and a little hiss | ok | bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass |
| vintage.lowpass | Low-pass cutoff | Vintage tone | ok | bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass |
| vintage.macro | Vintage | Scales every vintage depth together | ok | bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass |
| pad.choke | Choke group | A new hit in the group stops the other voice | ok | choke stops the other voice in the group |
| kit.repeatRate | Note Repeat | Retriggers the held pad on the grid | ok | note repeat speaks once per grid division |
| pad.velocitySense | Velocity sensitivity | How far the hit follows the played velocity. Zero uses the fixed velocity | ok | velocity sensitivity and the fixed curve change the hit |
| kit.velocityCurve | Velocity curve | Linear, soft, hard, or fixed | ok | velocity sensitivity and the fixed curve change the hit |
| pad.level | Pad volume | Loudness of the pad | ok | volume, pan, decay, attack, reverse, and loop |
| pad.pan | Pad pan | Left or right | ok | volume, pan, decay, attack, reverse, and loop |
| pad.decay | Pad decay | How long the pad rings, as a fraction of the window | fixed | volume, pan, decay, attack, reverse, and loop |
| pad.attack | Attack | Fade-in. Previously stored and ignored by the voice | fixed | volume, pan, decay, attack, reverse, and loop |
| pad.region.reverse | Reverse | Plays the window backwards | ok | volume, pan, decay, attack, reverse, and loop |
| pad.region.loop | Loop | Repeats the window | fixed | volume, pan, decay, attack, reverse, and loop |
| pad.send | Send | How much of this pad is added to each enabled track send | fixed | sends the pad to the bus by the send amount |
| chop.even | Chop | Even slices land on successive pads | ok | even chop puts a later slice on the next pad |
| sub.cutoff | Cutoff | Analog low-pass | ok | analog cutoff, resonance, drive, and mod mix the oscillators |
| sub.drive | Drive | Waveshaper on the oscillators | ok | analog cutoff, resonance, drive, and mod mix the oscillators |
| sub.mix2 | Osc 2 | Second oscillator level and detune | ok | analog cutoff, resonance, drive, and mod mix the oscillators |
| fm.mode | Mod mix | Mixes the modulator into the output. Was labeled Mode and did not change the sound | fixed | FM mod mix adds the modulator |
| fm.index | Index | Modulation depth | ok | FM mod mix adds the modulator |
| wave.position | Position | Wavetable frame | ok | wavetable position and filter move the tone |
| wave.cutoff | Cutoff | Wavetable low-pass | ok | wavetable position and filter move the tone |
| knock.decay | Decay | How long the hit rings | ok | knock decay, tone, and level follow the knobs |
| knock.cutoff | Tone | Low-pass brightness | ok | knock decay, tone, and level follow the knobs |
| knock.level | Level | Output level | ok | knock decay, tone, and level follow the knobs |
| filter.mode | High pass | Was labeled Mode. Up is a high-pass, down is a low-pass | fixed | filter high-pass removes lows and the arp direction reverses |
| arp.mode | Direction | Was labeled Mode. Up, down, or up-down | fixed | filter high-pass removes lows and the arp direction reverses |
| scaler.scale | Scale | Chord tones of the chosen scale | ok | plays the notes of the chosen scale and chord |
| scaler.group | Chord set | Triad, seventh, and the other chord sets | ok | plays the notes of the chosen scale and chord |
| scaler.rate | Rate | Speed of an arpeggio or performance | ok | rate and gate change the pattern |
| scaler.gate | Gate | How long each pattern note holds | ok | rate and gate change the pattern |
| tune.retune | Retune | How fast an off-pitch tone moves onto the scale | ok | retune speed and the key pull an off-pitch tone onto the scale |
| tune.root | Key | Scale the correction uses | ok | retune speed and the key pull an off-pitch tone onto the scale |
| tune.humanize | Humanize | Leaves more of the sung pitch | ok | humanize leaves more of the original pitch |
| pad.poly | Mono / Poly | Mono retriggers the pad. Poly is labeled as overlap and still uses the same voice slot | unverified | — |
| kit.fullLevel | Full Level | Forces velocity 127 in the performer. Not rendered offline here | unverified | — |
| kit.levels | 16 Levels | Spreads one pad across velocity, tune, or decay. Performer path, not an offline render here | unverified | — |

## Counts

| status | count |
| --- | --- |
| ok | 47 |
| fixed | 11 |
| removed | 0 |
| unverified | 3 |

## What changed

- Sampler pitch is applied while time-stretch is on. +12 doubles the frequency and the stretched length stays put. With stretch off, the length changes with the pitch.
- Vintage bit depth runs from clean to 4-bit. Sample-rate reduction holds at 24 kHz as soon as it is above zero, and the top of the knob goes to 4 kHz. The SP-1200 preset amounts still land on the previous 13-bit and 24 kHz hold.
- Pad attack, decay, and loop are part of the voice plan, so print, export, and the live pool hear them.
- Arrangement and the buffer-voice fallback render pads through that same pool, so pitch mode, vintage, filters, and choke are in the bounce. Pad send is added to each enabled track send. Track buffers are created before any track is mixed, so a send can reach a bus that comes later in the list.
- A library Loop with no loop points loops the whole sample. `makeProgram` keeps the play settings.
- FM Mode is now Mod mix. Filter Mode is High pass. Arp Mode is Direction.
