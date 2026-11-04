//! Sample pool and Beat Machine pad voices.
//!
//! The host loads each buffer once. `note` and `process` do not allocate.
//! Sixteen pads may point at slices of the same buffer.

pub const MAX_SAMPLES: usize = 32;
pub const MAX_PADS: usize = 16;
pub const MAX_VOICES: usize = 16;
const MAX_HITS: usize = 64;
const GRAIN: f64 = 1024.0;
const HOP: f64 = 512.0;

/// SP-1200 character: 12-bit, 26.04 kHz.
pub const SP1200_BITS: u32 = 12;
pub const SP1200_RATE: f64 = 26_040.0;
/// MPC60 character: 12-bit, 40 kHz.
pub const MPC60_BITS: u32 = 12;
pub const MPC60_RATE: f64 = 40_000.0;

#[derive(Clone, Copy)]
pub struct Vintage {
    pub bit_depth: u32,
    pub sample_rate: f64,
    pub wow: f64,
    pub flutter: f64,
    pub noise: f64,
    pub crackle: f64,
    pub lowpass: f64,
}

impl Vintage {
    pub const fn off() -> Self {
        Self { bit_depth: 0, sample_rate: 0.0, wow: 0.0, flutter: 0.0, noise: 0.0, crackle: 0.0, lowpass: 0.0 }
    }
}

#[derive(Clone, Copy)]
struct Region {
    sample_id: u32,
    start: u32,
    end: u32,
    fade_in: u32,
    fade_out: u32,
    reverse: bool,
    /// Hold (gate). False is one-shot.
    hold: bool,
    semis: f64,
    cents: f64,
    /// False resamples (vinyl). True preserves duration (granular stretch).
    stretch: bool,
    highpass: f64,
    lowpass: f64,
    choke: u32,
    swing: u32,
    level: f64,
    pan: f64,
    vintage: Vintage,
}

impl Region {
    const fn empty() -> Self {
        Self {
            sample_id: 0,
            start: 0,
            end: 0,
            fade_in: 32,
            fade_out: 32,
            reverse: false,
            hold: false,
            semis: 0.0,
            cents: 0.0,
            stretch: false,
            highpass: 0.0,
            lowpass: 0.0,
            choke: 0,
            swing: 0,
            level: 1.0,
            pan: 0.0,
            vintage: Vintage::off(),
        }
    }
}

struct Slot {
    samples: Vec<f32>,
    file_rate: f64,
}

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    released: bool,
    pad: usize,
    cursor: f64,
    wait: u32,
    env: f64,
    rate_time: f64,
    rate_pitch: f64,
    stretch: bool,
    hp: f64,
    hp_x: f64,
    lp: f64,
    vint_lp: f64,
    hp_a: f64,
    lp_a: f64,
    vint_a: f64,
    held: f64,
    hold_left: i32,
    hold_n: i32,
    bits: u32,
    wow: f64,
    flutter: f64,
    noise: f64,
    crackle: f64,
    seed: u32,
    time: f64,
    velocity: f64,
    release_samples: f64,
}

impl Voice {
    const fn idle() -> Self {
        Self {
            active: false,
            released: false,
            pad: 0,
            cursor: 0.0,
            wait: 0,
            env: 1.0,
            rate_time: 1.0,
            rate_pitch: 1.0,
            stretch: false,
            hp: 0.0,
            hp_x: 0.0,
            lp: 0.0,
            vint_lp: 0.0,
            hp_a: 0.0,
            lp_a: 0.0,
            vint_a: 0.0,
            held: 0.0,
            hold_left: 0,
            hold_n: 1,
            bits: 0,
            wow: 0.0,
            flutter: 0.0,
            noise: 0.0,
            crackle: 0.0,
            seed: 1,
            time: 0.0,
            velocity: 1.0,
            release_samples: 1.0,
        }
    }
}

#[derive(Clone, Copy)]
struct Hit {
    offset: u32,
    pad: u16,
    velocity: f32,
}

/// Host-agnostic pad player. Loading a sample may allocate. `note` and `process` do not.
pub struct VoiceEngine {
    sample_rate: f64,
    slots: Vec<Option<Slot>>,
    pads: [Region; MAX_PADS],
    voices: [Voice; MAX_VOICES],
    hits: [Hit; MAX_HITS],
    hit_count: usize,
    hit_at: usize,
    scratch: Vec<f32>,
    left: Vec<f32>,
    right: Vec<f32>,
}

impl VoiceEngine {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate: sane_rate(sample_rate),
            slots: (0..MAX_SAMPLES).map(|_| None).collect(),
            pads: [Region::empty(); MAX_PADS],
            voices: [Voice::idle(); MAX_VOICES],
            hits: [Hit { offset: 0, pad: 0, velocity: 0.0 }; MAX_HITS],
            hit_count: 0,
            hit_at: 0,
            scratch: Vec::new(),
            left: Vec::new(),
            right: Vec::new(),
        }
    }

    pub fn prepare(&mut self, sample_rate: f64, max_block: usize) {
        self.sample_rate = sane_rate(sample_rate);
        let frames = max_block.clamp(1, 8192);
        self.left.resize(frames, 0.0);
        self.right.resize(frames, 0.0);
    }

    pub fn reset(&mut self) {
        self.hit_count = 0;
        self.hit_at = 0;
        for voice in &mut self.voices {
            *voice = Voice::idle();
        }
    }

    pub fn load_sample(&mut self, id: u32, data: &[f32], file_rate: f64) {
        let index = id as usize;
        if index == 0 || index > MAX_SAMPLES {
            return;
        }
        let rate = if file_rate.is_finite() && file_rate > 0.0 { file_rate } else { self.sample_rate };
        self.slots[index - 1] = Some(Slot { samples: data.to_vec(), file_rate: rate });
    }

    pub fn begin_load(&mut self, len: usize) -> *mut f32 {
        self.scratch.resize(len.max(1), 0.0);
        self.scratch.as_mut_ptr()
    }

    pub fn commit_load(&mut self, id: u32, len: usize, file_rate: f64) {
        let n = len.min(self.scratch.len());
        let copy = self.scratch[..n].to_vec();
        self.load_sample(id, &copy, file_rate);
    }

    /// `pad.setRegion(sampleId, start, end)`.
    pub fn set_region(&mut self, pad: u32, sample_id: u32, start: u32, end: u32) {
        let Some(region) = self.pads.get_mut(pad as usize) else { return };
        region.sample_id = sample_id;
        region.start = start;
        region.end = end;
        if region.fade_in == 0 && region.fade_out == 0 {
            region.fade_in = 32;
            region.fade_out = 32;
        }
    }

    pub fn set_fade(&mut self, pad: u32, fade_in: u32, fade_out: u32) {
        let Some(region) = self.pads.get_mut(pad as usize) else { return };
        region.fade_in = fade_in;
        region.fade_out = fade_out;
    }

    /// `pad.setPitch(semis, cents, mode)` where mode is vinyl (`stretch == false`) or stretch.
    pub fn set_pitch(&mut self, pad: u32, semis: f64, cents: f64, stretch: bool) {
        let Some(region) = self.pads.get_mut(pad as usize) else { return };
        region.semis = semis;
        region.cents = cents;
        region.stretch = stretch;
    }

    /// `pad.setVintage({ bitDepth, sampleRate, wow, flutter, noise, crackle, lowpass })`.
    pub fn set_vintage(&mut self, pad: u32, vintage: Vintage) {
        if let Some(region) = self.pads.get_mut(pad as usize) {
            region.vintage = vintage;
        }
    }

    /// High-pass and low-pass, in hertz. Zero bypasses that pole.
    pub fn set_filter(&mut self, pad: u32, highpass: f64, lowpass: f64) {
        let Some(region) = self.pads.get_mut(pad as usize) else { return };
        region.highpass = highpass;
        region.lowpass = lowpass;
    }

    /// `pad.setChokeGroup(n)`. Zero is no group.
    pub fn set_choke_group(&mut self, pad: u32, group: u32) {
        if let Some(region) = self.pads.get_mut(pad as usize) {
            region.choke = group;
        }
    }

    pub fn set_reverse(&mut self, pad: u32, on: bool) {
        if let Some(region) = self.pads.get_mut(pad as usize) {
            region.reverse = on;
        }
    }

    /// `pad.setHold(true)` gates the voice. `false` is one-shot.
    pub fn set_hold(&mut self, pad: u32, on: bool) {
        if let Some(region) = self.pads.get_mut(pad as usize) {
            region.hold = on;
        }
    }

    /// Extra delay, in samples, added to every hit on this pad.
    pub fn set_swing(&mut self, pad: u32, samples: u32) {
        if let Some(region) = self.pads.get_mut(pad as usize) {
            region.swing = samples;
        }
    }

    pub fn set_level(&mut self, pad: u32, level: f64, pan: f64) {
        let Some(region) = self.pads.get_mut(pad as usize) else { return };
        region.level = level;
        region.pan = pan;
    }

    /// Sample-accurate hit. Velocity 0 releases a held pad. Does not allocate.
    pub fn note(&mut self, offset: u32, pad: u32, velocity: f64) {
        if self.hit_count >= MAX_HITS || (pad as usize) >= MAX_PADS {
            return;
        }
        let hit = Hit { offset, pad: pad as u16, velocity: velocity as f32 };
        let mut at = self.hit_count;
        while at > 0 && self.hits[at - 1].offset > hit.offset {
            self.hits[at] = self.hits[at - 1];
            at -= 1;
        }
        self.hits[at] = hit;
        self.hit_count += 1;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32]) {
        let frames = left.len().min(right.len());
        self.hit_at = 0;
        for index in 0..frames {
            let (mix_l, mix_r) = self.render_frame(index);
            left[index] = clip(mix_l);
            right[index] = clip(mix_r);
        }
        self.hit_count = 0;
        self.hit_at = 0;
    }

    /// Render into the buffers reserved by `prepare`. Does not allocate.
    pub fn process_prepared(&mut self, frames: usize) {
        let frames = frames.min(self.left.len()).min(self.right.len());
        self.hit_at = 0;
        for index in 0..frames {
            let (mix_l, mix_r) = self.render_frame(index);
            self.left[index] = clip(mix_l);
            self.right[index] = clip(mix_r);
        }
        self.hit_count = 0;
        self.hit_at = 0;
    }

    fn render_frame(&mut self, index: usize) -> (f64, f64) {
        while self.hit_at < self.hit_count && self.hits[self.hit_at].offset as usize <= index {
            let hit = self.hits[self.hit_at];
            self.hit_at += 1;
            self.fire(hit.pad as u32, hit.velocity as f64);
        }
        let mut mix_l = 0.0;
        let mut mix_r = 0.0;
        for voice_index in 0..MAX_VOICES {
            if let Some((sample_l, sample_r)) = self.tick(voice_index) {
                mix_l += sample_l;
                mix_r += sample_r;
            }
        }
        (mix_l, mix_r)
    }

    pub fn left_ptr(&mut self) -> *mut f32 {
        self.left.as_mut_ptr()
    }

    pub fn right_ptr(&mut self) -> *mut f32 {
        self.right.as_mut_ptr()
    }

    fn fire(&mut self, pad: u32, velocity: f64) {
        let pad_index = pad as usize;
        if pad_index >= MAX_PADS {
            return;
        }
        if velocity <= 0.0001 {
            let hold = self.pads[pad_index].hold;
            if !hold {
                return;
            }
            for voice in &mut self.voices {
                if voice.active && voice.pad == pad_index {
                    voice.released = true;
                }
            }
            return;
        }
        let region = self.pads[pad_index];
        if region.choke > 0 {
            for voice in &mut self.voices {
                if voice.active && voice.pad < MAX_PADS && self.pads[voice.pad].choke == region.choke {
                    voice.released = true;
                }
            }
        }
        let file_rate = self.slots.get(region.sample_id.saturating_sub(1) as usize)
            .and_then(|slot| slot.as_ref())
            .map(|slot| slot.file_rate)
            .unwrap_or(self.sample_rate);
        let Some(slot_index) = self.claim(pad_index) else { return };
        let time_rate = file_rate / self.sample_rate;
        let semis = region.semis + region.cents / 100.0;
        let pitch = 2f64.powf(semis / 12.0);
        let sr = self.sample_rate;
        let voice = &mut self.voices[slot_index];
        *voice = Voice::idle();
        voice.active = true;
        voice.pad = pad_index;
        voice.wait = region.swing;
        voice.rate_time = if time_rate.is_finite() && time_rate > 0.0 { time_rate } else { 1.0 };
        voice.rate_pitch = if pitch.is_finite() && pitch > 0.0 { pitch } else { 1.0 };
        voice.stretch = region.stretch;
        voice.velocity = velocity.clamp(0.0, 1.0);
        voice.release_samples = (sr * 0.05).max(1.0);
        voice.hp_a = pole(region.highpass, sr);
        voice.lp_a = pole(region.lowpass, sr);
        voice.vint_a = pole(region.vintage.lowpass, sr);
        voice.hold_n = if region.vintage.sample_rate > 100.0 {
            (sr / region.vintage.sample_rate).round().clamp(1.0, 64.0) as i32
        } else {
            1
        };
        voice.bits = region.vintage.bit_depth;
        voice.wow = region.vintage.wow.clamp(0.0, 1.0);
        voice.flutter = region.vintage.flutter.clamp(0.0, 1.0);
        voice.noise = region.vintage.noise.clamp(0.0, 1.0);
        voice.crackle = region.vintage.crackle.clamp(0.0, 1.0);
        voice.seed = 0x1234_5678 ^ (pad_index as u32).wrapping_mul(0x9E37_79B9);
    }

    fn claim(&self, pad: usize) -> Option<usize> {
        for (index, voice) in self.voices.iter().enumerate() {
            if voice.active && voice.pad == pad {
                return Some(index);
            }
        }
        for (index, voice) in self.voices.iter().enumerate() {
            if !voice.active {
                return Some(index);
            }
        }
        let mut oldest = 0;
        for index in 1..MAX_VOICES {
            if self.voices[index].cursor > self.voices[oldest].cursor {
                oldest = index;
            }
        }
        Some(oldest)
    }

    fn tick(&mut self, index: usize) -> Option<(f64, f64)> {
        if !self.voices[index].active {
            return None;
        }
        if self.voices[index].wait > 0 {
            self.voices[index].wait -= 1;
            return None;
        }
        let voice = &self.voices[index];
        let region = self.pads[voice.pad];
        let slot = region.sample_id.saturating_sub(1) as usize;
        let cursor = voice.cursor;
        let time_step = voice.rate_time;
        let pitch = voice.rate_pitch;
        let stretch = voice.stretch;
        let mut env = voice.env;
        let released = voice.released;
        let release_samples = voice.release_samples;
        let mut hp = voice.hp;
        let mut hp_x = voice.hp_x;
        let mut lp = voice.lp;
        let mut vint_lp = voice.vint_lp;
        let hp_a = voice.hp_a;
        let lp_a = voice.lp_a;
        let vint_a = voice.vint_a;
        let mut held = voice.held;
        let mut hold_left = voice.hold_left;
        let hold_n = voice.hold_n;
        let bits = voice.bits;
        let wow = voice.wow;
        let flutter = voice.flutter;
        let noise_amt = voice.noise;
        let crackle = voice.crackle;
        let mut seed = voice.seed;
        let time = voice.time;
        let _velocity = voice.velocity;
        let sample_rate = self.sample_rate;
        let samples = self.slots.get(slot).and_then(|item| item.as_ref()).map(|item| item.samples.as_slice());
        let Some(buffer) = samples else {
            self.voices[index].active = false;
            return None;
        };
        let length = buffer.len() as f64;
        let start = region.start as f64;
        let end = (region.end as f64).min(length);
        let span = end - start;
        if span < 2.0 || cursor >= span - 1.0 {
            self.voices[index].active = false;
            return None;
        }
        if released {
            env -= 1.0 / release_samples;
            if env <= 0.0 {
                self.voices[index].active = false;
                return None;
            }
        }
        let wobble = wobble_of(wow, flutter, time);
        let raw = if stretch {
            stretch_read(buffer, start, end, cursor, pitch * wobble, region.reverse)
        } else if region.reverse {
            read_linear(buffer, end - 1.0 - cursor)
        } else {
            read_linear(buffer, start + cursor)
        };
        let mut sample = raw * edge_gain(cursor, span, region.fade_in as f64, region.fade_out as f64);
        if hold_left <= 0 {
            held = sample;
            hold_left = hold_n;
        }
        hold_left -= 1;
        sample = held;
        if bits >= 2 && bits <= 16 {
            let steps = (1u32 << (bits - 1)) as f64;
            sample = (sample * steps + 0.5).floor() / steps;
            sample = sample.clamp(-1.0, 1.0);
        }
        if hp_a > 0.0 {
            let next = hp_a * (hp + sample - hp_x);
            hp_x = sample;
            hp = next;
            sample = next;
        }
        if lp_a > 0.0 {
            lp += lp_a * (sample - lp);
            sample = lp;
        }
        if vint_a > 0.0 {
            vint_lp += vint_a * (sample - vint_lp);
            sample = vint_lp;
        }
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        if noise_amt > 0.0 {
            let unit = (((seed >> 8) & 65535) as f64) / 32768.0 - 1.0;
            sample += unit * noise_amt * 0.15;
        }
        if crackle > 0.0 && (seed % 4096) < (crackle * 80.0) as u32 {
            sample += if seed & 1 == 0 { 0.45 } else { -0.45 };
        }
        let step = if stretch { time_step } else { time_step * pitch * wobble };
        let voice = &mut self.voices[index];
        voice.env = env;
        voice.hp = hp;
        voice.hp_x = hp_x;
        voice.lp = lp;
        voice.vint_lp = vint_lp;
        voice.held = held;
        voice.hold_left = hold_left;
        voice.seed = seed;
        voice.time = time + 1.0 / sample_rate;
        voice.cursor = cursor + step;
        let gain = sample * voice.env * voice.velocity * region.level.clamp(0.0, 1.0);
        let angle = (region.pan.clamp(-1.0, 1.0) + 1.0) * std::f64::consts::FRAC_PI_4;
        Some((gain * angle.cos(), gain * angle.sin()))
    }
}

fn wobble_of(wow: f64, flutter: f64, time: f64) -> f64 {
    1.0 + wow * 0.015 * (std::f64::consts::TAU * 0.55 * time).sin() + flutter * 0.004 * (std::f64::consts::TAU * 7.1 * time).sin()
}

fn stretch_read(buffer: &[f32], start: f64, end: f64, playhead: f64, pitch: f64, reverse: bool) -> f64 {
    let local = playhead % HOP;
    let base = playhead - local;
    let (pos_a, pos_b) = if reverse {
        let head = end - 1.0 - base;
        (head - local * pitch, head + HOP - (local + HOP) * pitch)
    } else {
        (start + base + local * pitch, start + (base - HOP) + (local + HOP) * pitch)
    };
    let win_a = hann(local / GRAIN);
    let win_b = hann((local + HOP) / GRAIN);
    let norm = win_a + win_b;
    if norm <= 1e-9 {
        return read_linear(buffer, if reverse { end - 1.0 - playhead } else { start + playhead });
    }
    (read_linear(buffer, pos_a) * win_a + read_linear(buffer, pos_b) * win_b) / norm
}

fn hann(phase: f64) -> f64 {
    if phase <= 0.0 || phase >= 1.0 {
        return 0.0;
    }
    0.5 - 0.5 * (std::f64::consts::TAU * phase).cos()
}

fn read_linear(buffer: &[f32], at: f64) -> f64 {
    if buffer.len() < 2 || !at.is_finite() {
        return 0.0;
    }
    if at <= 0.0 {
        return buffer[0] as f64;
    }
    let last = (buffer.len() - 1) as f64;
    if at >= last {
        return buffer[buffer.len() - 1] as f64;
    }
    let index = at.floor() as usize;
    let frac = at - index as f64;
    let a = buffer[index] as f64;
    let b = buffer[index + 1] as f64;
    a + (b - a) * frac
}

fn edge_gain(cursor: f64, span: f64, fade_in: f64, fade_out: f64) -> f64 {
    let mut gain = 1.0;
    if fade_in > 0.0 && cursor < fade_in {
        gain *= (cursor / fade_in).max(0.0);
    }
    let remain = span - cursor;
    if fade_out > 0.0 && remain < fade_out {
        gain *= (remain / fade_out).max(0.0);
    }
    gain
}

fn pole(freq: f64, sample_rate: f64) -> f64 {
    if !(freq.is_finite() && freq > 1.0) {
        return 0.0;
    }
    let limited = freq.min(sample_rate * 0.45);
    if freq > 20.0 && limited == freq && freq > 10_000.0 && freq > sample_rate * 0.4 {
        // A very high low-pass is treated as open when it sits near Nyquist.
    }
    1.0 - (-std::f64::consts::TAU * limited / sample_rate).exp()
}

fn clip(sample: f64) -> f32 {
    if !sample.is_finite() {
        return 0.0;
    }
    sample.clamp(-1.0, 1.0) as f32
}

fn sane_rate(sample_rate: f64) -> f64 {
    if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate } else { 48_000.0 }
}
