//! Auto-Tune. Pitch engine is `Psola`. Snap rules follow `tuneSnapMidi` and `targetHz`.
//! New parameters are appended after `n11` (index 30). Do not insert earlier indexes.

use crate::psola::{PitchFrame, Psola};
use crate::util::{clamp, js_round, param, store};

const TRACKING: usize = 31;
const TRANSITION: usize = 32;
const THROAT: usize = 33;
const VIBE_RATE: usize = 34;
const VIBE_DEPTH: usize = 35;
const VIBE_ONSET: usize = 36;
const AUTO_KEY: usize = 37;
const MIDI: usize = 38;
const HARMONY: usize = 39;
const VOICE: usize = 40;
const REGION: usize = 45;

const MAJOR_PROFILE: [f64; 12] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: [f64; 12] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SCALES: [&[i32]; 19] = [
    &[0, 2, 4, 5, 7, 9, 11],
    &[0, 2, 3, 5, 7, 9, 10],
    &[0, 1, 3, 5, 7, 8, 10],
    &[0, 2, 4, 6, 7, 9, 11],
    &[0, 2, 4, 5, 7, 9, 10],
    &[0, 2, 3, 5, 7, 8, 10],
    &[0, 1, 3, 5, 6, 8, 10],
    &[0, 2, 3, 5, 7, 8, 11],
    &[0, 2, 3, 5, 7, 9, 11],
    &[0, 2, 4, 7, 9],
    &[0, 3, 5, 7, 10],
    &[0, 3, 5, 6, 7, 10],
    &[0, 2, 4, 6, 8, 10],
    &[0, 1, 3, 4, 6, 7, 9, 10],
    &[0, 2, 3, 5, 6, 8, 9, 11],
    &[0, 2, 3, 7, 8],
    &[0, 1, 4, 5, 7, 8, 10],
    &[0, 2, 3, 6, 7, 8, 11],
    &[0, 1, 5, 7, 10],
];

struct Snap {
    smoothed: f64,
    center: f64,
    quiet: i32,
    last_note: i32,
    phase: f64,
    age: f64,
}

impl Snap {
    fn new() -> Self {
        Self { smoothed: 0.0, center: 0.0, quiet: 0, last_note: -1, phase: 0.0, age: 0.0 }
    }
}

struct KeyLock {
    root: i32,
    scale: i32,
    ready: bool,
    hist: [f64; 12],
}

impl KeyLock {
    fn new() -> Self {
        Self { root: 0, scale: 0, ready: false, hist: [0.0; 12] }
    }

    fn clear(&mut self) {
        self.ready = false;
        self.hist = [0.0; 12];
    }
}

struct Voice {
    hq: Psola,
    live: Psola,
    state: Snap,
}

impl Voice {
    fn new(sample_rate: f64, live_hop: usize) -> Self {
        Self {
            hq: Psola::new(sample_rate, 0),
            live: Psola::new(sample_rate, live_hop),
            state: Snap::new(),
        }
    }

    fn reset(&mut self) {
        self.hq.reset();
        self.live.reset();
        self.state = Snap::new();
    }
}

pub struct Tune {
    hq: Psola,
    live: Psola,
    voices: [Voice; 4],
    lead: Snap,
    lock: KeyLock,
    midi_note: i32,
    /// 0 dry, 1 live, 2 hq.
    path: u8,
    harmony_on: bool,
    throat: [f64; 2],
    dry_l: Vec<f32>,
    dry_r: Vec<f32>,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
    rate: f64,
    pub latency: u32,
}

impl Tune {
    pub fn new(sample_rate: f64) -> Self {
        let live_hop = tune_live_hop(sample_rate);
        Self {
            hq: Psola::new(sample_rate, 0),
            live: Psola::new(sample_rate, live_hop),
            voices: [
                Voice::new(sample_rate, live_hop),
                Voice::new(sample_rate, live_hop),
                Voice::new(sample_rate, live_hop),
                Voice::new(sample_rate, live_hop),
            ],
            lead: Snap::new(),
            lock: KeyLock::new(),
            midi_note: -1,
            path: 0,
            harmony_on: false,
            throat: [0.0, 0.0],
            dry_l: vec![0.0; 8192],
            dry_r: vec![0.0; 8192],
            scratch_l: vec![0.0; 8192],
            scratch_r: vec![0.0; 8192],
            rate: sample_rate,
            latency: 0,
        }
    }

    pub fn note(&mut self, pitch: f64, vel: f64) {
        if vel <= 0.0 {
            self.midi_note = -1;
        } else {
            self.midi_note = js_round(pitch).clamp(0.0, 127.0) as i32;
        }
    }

    pub fn reset(&mut self) {
        self.hq.reset();
        self.live.reset();
        for voice in &mut self.voices {
            voice.reset();
        }
        self.clear_lead();
        self.midi_note = -1;
        self.path = 0;
        self.harmony_on = false;
        self.latency = 0;
    }

    fn clear_lead(&mut self) {
        self.lead = Snap::new();
        self.lock.clear();
        self.throat = [0.0, 0.0];
    }

    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        frames: usize,
        values: &[f64],
        sample_rate: f64,
        offline: bool,
        eco: bool,
        scale_root: i32,
        intervals: &[i32],
        cents: &[f64],
    ) {
        let _ = self.rate;
        let amount = param(values, 3, 0.85);
        if amount <= 0.001 {
            if self.path != 0 {
                self.hq.reset();
                self.live.reset();
                for voice in &mut self.voices {
                    voice.hq.reset();
                    voice.live.reset();
                }
                self.clear_lead();
                self.path = 0;
            }
            self.latency = 0;
            for i in 0..frames {
                let l = left.get(i).copied().unwrap_or(0.0) as f64;
                let r = right.get(i).copied().unwrap_or(left.get(i).copied().unwrap_or(0.0)) as f64;
                if i < left.len() {
                    left[i] = store(l);
                }
                if i < right.len() {
                    right[i] = store(r);
                }
            }
            return;
        }
        let hq = param(values, 15, 0.0);
        let monitoring = !offline && hq < 0.5;
        let path = if monitoring { 1 } else { 2 };
        if self.path != path {
            if monitoring {
                self.live.reset();
                for voice in &mut self.voices {
                    voice.live.reset();
                }
            } else {
                self.hq.reset();
                for voice in &mut self.voices {
                    voice.hq.reset();
                }
            }
            self.clear_lead();
            for voice in &mut self.voices {
                voice.state = Snap::new();
            }
            self.path = path;
            self.harmony_on = false;
        }
        self.latency = if monitoring {
            tune_live_latency(sample_rate)
        } else {
            tune_latency(sample_rate)
        };
        let hop = if monitoring {
            tune_live_hop(sample_rate) as f64
        } else if eco {
            256.0
        } else {
            128.0
        };
        let min_hz = crate::util::js_or(param(values, 9, 80.0), 80.0);
        let max_hz = crate::util::js_or(param(values, 10, 900.0), 900.0);
        let formant = param(values, 5, 0.0);
        let held = held_note(values, self.midi_note);
        let midi_open = param(values, MIDI, 0.0) >= 0.5 && held < 0;
        let use_harmony = !midi_open && harmony_requested(values);
        let n = frames.min(self.dry_l.len()).min(left.len()).min(right.len());
        if use_harmony {
            self.dry_l[..n].copy_from_slice(&left[..n]);
            self.dry_r[..n].copy_from_slice(&right[..n]);
            if !self.harmony_on {
                for voice in &mut self.voices {
                    if monitoring {
                        voice.live.reset();
                    } else {
                        voice.hq.reset();
                    }
                    voice.state = Snap::new();
                }
            }
        }
        self.harmony_on = use_harmony;
        if monitoring {
            drive(&mut self.live, left, right, frames, values, sample_rate, scale_root, intervals, cents, &mut self.lead, &mut self.lock, 0.0, true, held, hop, min_hz, max_hz, formant);
        } else {
            drive(&mut self.hq, left, right, frames, values, sample_rate, scale_root, intervals, cents, &mut self.lead, &mut self.lock, 0.0, true, held, hop, min_hz, max_hz, formant);
        }
        if use_harmony {
            let gain = clamp(param(values, HARMONY, 0.0), 0.0, 1.0) * 0.32;
            for v in 0..4 {
                let interval = js_round(param(values, VOICE + v, 0.0));
                if interval == 0.0 || n == 0 {
                    continue;
                }
                let mut scratch_l = std::mem::take(&mut self.scratch_l);
                let mut scratch_r = std::mem::take(&mut self.scratch_r);
                scratch_l[..n].copy_from_slice(&self.dry_l[..n]);
                scratch_r[..n].copy_from_slice(&self.dry_r[..n]);
                {
                    let voice = &mut self.voices[v];
                    let Voice { hq, live, state } = voice;
                    let engine = if monitoring { live } else { hq };
                    drive(engine, &mut scratch_l[..n], &mut scratch_r[..n], n, values, sample_rate, scale_root, intervals, cents, state, &mut self.lock, interval, false, held, hop, min_hz, max_hz, formant);
                }
                let left_gain = gain * if v % 2 == 0 { 0.7 } else { 0.3 };
                let right_gain = gain * if v % 2 == 0 { 0.3 } else { 0.7 };
                for i in 0..n {
                    left[i] = store(left[i] as f64 + scratch_l[i] as f64 * left_gain);
                    right[i] = store(right[i] as f64 + scratch_r[i] as f64 * right_gain);
                }
                self.scratch_l = scratch_l;
                self.scratch_r = scratch_r;
            }
        }
        apply_throat(left, right, frames, param(values, THROAT, 0.0), sample_rate, &mut self.throat);
    }
}

fn held_note(values: &[f64], midi_note: i32) -> i32 {
    let param_held = js_round(param(values, 18, -1.0)) as i32;
    if (0..=127).contains(&param_held) {
        return param_held;
    }
    if (0..=127).contains(&midi_note) { midi_note } else { -1 }
}

fn harmony_requested(values: &[f64]) -> bool {
    if param(values, HARMONY, 0.0) <= 0.001 {
        return false;
    }
    for i in 0..4 {
        if js_round(param(values, VOICE + i, 0.0)) != 0.0 {
            return true;
        }
    }
    false
}

fn drive(
    engine: &mut Psola,
    left: &mut [f32],
    right: &mut [f32],
    frames: usize,
    values: &[f64],
    sample_rate: f64,
    scale_root: i32,
    intervals: &[i32],
    cents: &[f64],
    state: &mut Snap,
    lock: &mut KeyLock,
    extra: f64,
    update_key: bool,
    held: i32,
    hop: f64,
    min_hz: f64,
    max_hz: f64,
    formant: f64,
) {
    let snap = |frame: PitchFrame| {
        let corrected = target_hz(frame, values, scale_root, intervals, cents, state, lock, extra, update_key, held, hop, sample_rate);
        if corrected <= 0.0 {
            state.quiet += 1;
            if state.quiet > 4 {
                state.smoothed = 0.0;
                state.center = 0.0;
                state.last_note = -1;
                state.age = 0.0;
            }
        } else {
            state.quiet = 0;
        }
        corrected
    };
    engine.process(left, right, frames, snap, sample_rate, min_hz, max_hz, hop, formant);
}

fn tracking_gate(tracking: f64) -> f64 {
    if (tracking - 0.5).abs() <= 1e-12 {
        return 0.7;
    }
    let amount = clamp(tracking, 0.0, 1.0);
    0.95 - amount * 0.5
}

fn correction_rate(speed: f64, classic: bool, transition: f64, changed: bool) -> f64 {
    let clipped = clamp(speed, 0.02, 1.0);
    let mut rate = if classic { (0.35 + clipped * 0.65).min(1.0) } else { clipped };
    if changed && transition < 0.999 {
        rate = (rate * clamp(transition, 0.0, 1.0)).max(0.02);
    }
    rate
}

fn key_from_hist(hist: &[f64; 12]) -> Option<(i32, i32)> {
    let mut total = 0.0;
    for value in hist {
        total += *value;
    }
    if total < 4.0 {
        return None;
    }
    let mut best_score = f64::NEG_INFINITY;
    let mut best_root = 0;
    let mut best_minor = false;
    for root in 0..12 {
        let mut major = 0.0;
        let mut minor = 0.0;
        for degree in 0..12 {
            let weight = hist[(root + degree) % 12];
            major += weight * MAJOR_PROFILE[degree];
            minor += weight * MINOR_PROFILE[degree];
        }
        if major > best_score {
            best_score = major;
            best_root = root as i32;
            best_minor = false;
        }
        if minor > best_score {
            best_score = minor;
            best_root = root as i32;
            best_minor = true;
        }
    }
    Some((best_root, if best_minor { 5 } else { 0 }))
}

fn match_region(values: &[f64], midi: f64) -> Option<(f64, f64)> {
    let note = js_round(midi) as i32;
    for slot in 0..4 {
        let lo = js_round(param(values, REGION + slot * 4, 0.0)) as i32;
        let hi = js_round(param(values, REGION + slot * 4 + 1, 0.0)) as i32;
        if hi < lo || (lo == 0 && hi == 0) {
            continue;
        }
        if note >= lo && note <= hi {
            let ct = param(values, REGION + slot * 4 + 2, 0.0);
            let amt = param(values, REGION + slot * 4 + 3, 1.0);
            return Some((ct, amt));
        }
    }
    None
}

fn apply_throat(left: &mut [f32], right: &mut [f32], frames: usize, throat: f64, sample_rate: f64, low: &mut [f64; 2]) {
    let tilt = clamp(throat, -1.0, 1.0);
    if tilt.abs() < 1e-6 {
        return;
    }
    let rate = if sample_rate > 0.0 { sample_rate } else { 48_000.0 };
    let coeff = 1.0 - (-2.0 * std::f64::consts::PI * 1400.0 / rate).exp();
    let mix = tilt * 0.85;
    let frames = frames.min(left.len());
    for i in 0..frames {
        let sample = left[i] as f64;
        low[0] += coeff * (sample - low[0]);
        left[i] = store(sample + mix * (sample - low[0]));
    }
    let frames = frames.min(right.len());
    for i in 0..frames {
        let sample = right[i] as f64;
        low[1] += coeff * (sample - low[1]);
        right[i] = store(sample + mix * (sample - low[1]));
    }
}

fn js_sign(value: f64) -> f64 {
    if value > 0.0 {
        1.0
    } else if value < 0.0 {
        -1.0
    } else {
        0.0
    }
}

fn target_hz(
    frame: PitchFrame,
    values: &[f64],
    scale_root: i32,
    intervals: &[i32],
    cents: &[f64],
    state: &mut Snap,
    lock: &mut KeyLock,
    extra: f64,
    update_key: bool,
    held: i32,
    hop: f64,
    sample_rate: f64,
) -> f64 {
    if frame.hz <= 0.0 || frame.confidence < tracking_gate(param(values, TRACKING, 0.5)) {
        return 0.0;
    }
    let reference = clamp(param(values, 14, 440.0), 430.0, 450.0);
    let midi = 69.0 + 12.0 * (frame.hz / reference).log2() + param(values, 4, 0.0) + extra;
    let heard_pc = mod_floor(js_round(midi) as i32, 12);
    let bypass = js_round(param(values, 13, 0.0)) as i32;
    if bypass & (1 << heard_pc) != 0 {
        return 0.0;
    }
    if param(values, MIDI, 0.0) >= 0.5 && !(0..=127).contains(&held) {
        return 0.0;
    }
    if update_key && param(values, AUTO_KEY, 0.0) >= 0.5 {
        for bin in &mut lock.hist {
            *bin *= 0.998;
        }
        let index = heard_pc as usize;
        if index < 12 {
            lock.hist[index] += 1.0;
        }
        if let Some((root, scale)) = key_from_hist(&lock.hist) {
            lock.root = root;
            lock.scale = scale;
            lock.ready = true;
        }
    }
    let follow = lock.ready && param(values, AUTO_KEY, 0.0) >= 0.5;
    let snapped = if (0..=127).contains(&held) {
        held as f64 + extra
    } else if follow {
        tune_snap_follow(midi, values, lock.root, lock.scale)
    } else {
        tune_snap_midi(midi, values, scale_root, intervals, cents)
    };
    let region = match_region(values, snapped);
    let nudge_pc = mod_floor(js_round(snapped) as i32, 12);
    let class_nudge = clamp(param(values, 19 + nudge_pc as usize, 0.0), -200.0, 200.0) / 100.0;
    let nudge = if let Some((ct, _)) = region {
        clamp(ct, -200.0, 200.0) / 100.0
    } else {
        class_nudge
    };
    let goal = reference * 2f64.powf((snapped + nudge - 69.0) / 12.0);
    let slow = if state.center == 0.0 { frame.hz } else { state.center };
    state.center = slow + (frame.hz - slow) * 0.08;
    let human = clamp(param(values, 1, 0.05), 0.0, 1.0);
    let amount = if let Some((_, amt)) = region {
        clamp(amt, 0.0, 1.0)
    } else {
        clamp(param(values, 3, 0.85), 0.0, 1.0)
    };
    let classic = param(values, 16, 0.0) >= 0.5;
    let flex = if classic { 0.0 } else { clamp(param(values, 2, 0.0), 0.0, 1.0) };
    let cents_off = 1200.0 * (frame.hz / goal).log2();
    let window = flex * 40.0;
    let pull = js_sign(cents_off) * (cents_off.abs() - window).max(0.0);
    let flexed = frame.hz * 2f64.powf(-pull / 1200.0);
    let kept = flexed + human * (frame.hz - flexed);
    let mut aimed = frame.hz + amount * (kept - frame.hz);
    let vibe = clamp(param(values, 17, 0.0), 0.0, 1.0);
    if vibe > 0.0 {
        aimed += vibe * (frame.hz - slow);
    }
    let note = js_round(snapped) as i32;
    let changed = state.last_note >= 0 && note != state.last_note;
    state.last_note = note;
    let depth = clamp(param(values, VIBE_DEPTH, 0.0), 0.0, 100.0);
    if depth > 0.0 {
        let rate_hz = clamp(param(values, VIBE_RATE, 5.0), 0.2, 8.0);
        state.phase += 2.0 * std::f64::consts::PI * rate_hz * (hop / sample_rate);
        if state.phase > std::f64::consts::PI * 2.0 {
            state.phase -= std::f64::consts::PI * 2.0;
        }
        if changed {
            state.age = 0.0;
        } else {
            state.age += hop;
        }
        let onset = clamp(param(values, VIBE_ONSET, 0.0), 0.0, 1.0) * sample_rate * 0.5;
        if state.age >= onset {
            aimed *= 2f64.powf((state.phase.sin() * depth) / 1200.0);
        }
    }
    let speed = clamp(param(values, 0, 0.5), 0.02, 1.0);
    let rate = correction_rate(speed, classic, param(values, TRANSITION, 1.0), changed);
    let prev = if state.smoothed == 0.0 { frame.hz } else { state.smoothed };
    let next = prev + (aimed - prev) * rate;
    state.smoothed = next;
    clamp(next, 40.0, 2000.0)
}

/// Scale snap with the mask cleared and the detected key, matching the TypeScript params override.
fn tune_snap_follow(midi: f64, values: &[f64], root: i32, scale: i32) -> f64 {
    let mut cleared = [0.0; 64];
    let count = values.len().min(cleared.len());
    cleared[..count].copy_from_slice(&values[..count]);
    if cleared.len() > 6 {
        cleared[6] = 1.0;
    }
    if cleared.len() > 7 {
        cleared[7] = root as f64;
    }
    if cleared.len() > 8 {
        cleared[8] = scale as f64;
    }
    if cleared.len() > 11 {
        cleared[11] = 0.0;
    }
    if cleared.len() > 12 {
        cleared[12] = 0.0;
    }
    tune_snap_midi(midi, &cleared, root, &[], &[])
}

fn tune_snap_midi(midi: f64, values: &[f64], scale_root: i32, intervals: &[i32], cents: &[f64]) -> f64 {
    let mask = js_round(param(values, 11, 0.0)) as i32;
    let mask_on = param(values, 12, 0.0) >= 0.5 || mask > 0;
    let chromatic = param(values, 6, 1.0) < 0.5 && !mask_on;
    let root_param = param(values, 7, -1.0);
    let root = if root_param >= 0.0 { js_round(root_param) as i32 } else { scale_root };
    let scale_index = js_round(param(values, 8, -1.0)) as i32;
    if !chromatic && !mask_on && scale_index < 0 {
        if !cents.is_empty() {
            return nearest_cents(midi, root, cents);
        }
        let mut degrees = [0.0; 24];
        let count = intervals.len().min(24);
        if count == 0 {
            let major = [0.0, 200.0, 400.0, 500.0, 700.0, 900.0, 1100.0];
            return nearest_cents(midi, root, &major);
        }
        for (index, interval) in intervals.iter().take(count).enumerate() {
            degrees[index] = *interval as f64 * 100.0;
        }
        return nearest_cents(midi, root, &degrees[..count]);
    }
    let scale = if scale_index >= 0 && (scale_index as usize) < SCALES.len() {
        SCALES[scale_index as usize]
    } else if !intervals.is_empty() {
        intervals
    } else {
        SCALES[0]
    };
    let mut best = js_round(midi) as i32;
    let mut best_dist = 99.0;
    let start = midi.floor() as i32 - 3;
    let end = midi.ceil() as i32 + 3;
    for note in start..=end {
        let pc = mod_floor(note, 12);
        let rel = mod_floor(pc - root, 12);
        let allowed = if mask_on {
            mask & (1 << pc) != 0
        } else if chromatic {
            true
        } else {
            scale.contains(&rel)
        };
        if !allowed {
            continue;
        }
        let dist = (note as f64 - midi).abs();
        if dist < best_dist || (dist == best_dist && note < best) {
            best = note;
            best_dist = dist;
        }
    }
    best as f64
}

fn nearest_cents(midi: f64, root: i32, degrees: &[f64]) -> f64 {
    let target = midi * 100.0;
    let root_pc = mod_floor(root, 12);
    let center = js_round(midi / 12.0) as i32 * 12 + root_pc;
    let mut best = target;
    let mut best_dist = f64::INFINITY;
    for oct in -2..=2 {
        let tonic = (center + oct * 12) as f64 * 100.0;
        for degree in degrees {
            let abs = tonic + *degree;
            let dist = (abs - target).abs();
            if dist < best_dist - 0.01 || ((dist - best_dist).abs() <= 0.01 && abs < best) {
                best_dist = dist;
                best = abs;
            }
        }
    }
    best / 100.0
}

fn mod_floor(value: i32, modulo: i32) -> i32 {
    let mut wrapped = value % modulo;
    if wrapped < 0 {
        wrapped += modulo;
    }
    wrapped
}

pub fn tune_live_hop(sample_rate: f64) -> usize {
    js_round(256.0 * (sample_rate / 48_000.0)).max(128.0) as usize
}

pub fn tune_live_latency(sample_rate: f64) -> u32 {
    let hop = tune_live_hop(sample_rate) as f64;
    let span = (1536.0 * (sample_rate / 48_000.0)).round().max(1024.0);
    let ahead = hop.max(((span - 1.0) / 2.0).floor());
    (ahead + hop) as u32
}

pub fn tune_latency(sample_rate: f64) -> u32 {
    let span = (1536.0 * (sample_rate / 48_000.0)).round().max(1024.0);
    (span + (span / 2.0).floor()) as u32
}
