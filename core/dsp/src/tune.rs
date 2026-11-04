//! Auto-Tune. Pitch engine is `Psola`. Snap rules follow `tuneSnapMidi` and `targetHz`.

use crate::psola::{PitchFrame, Psola};
use crate::util::{clamp, js_round, param, store};

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

pub struct Tune {
    hq: Psola,
    live: Psola,
    smoothed: f64,
    center: f64,
    quiet: i32,
    /// 0 dry, 1 live, 2 hq.
    path: u8,
    rate: f64,
    pub latency: u32,
}

impl Tune {
    pub fn new(sample_rate: f64) -> Self {
        let live_hop = tune_live_hop(sample_rate);
        Self {
            hq: Psola::new(sample_rate, 0),
            live: Psola::new(sample_rate, live_hop),
            smoothed: 0.0,
            center: 0.0,
            quiet: 0,
            path: 0,
            rate: sample_rate,
            latency: 0,
        }
    }

    pub fn reset(&mut self) {
        self.hq.reset();
        self.live.reset();
        self.smoothed = 0.0;
        self.center = 0.0;
        self.quiet = 0;
        self.path = 0;
        self.latency = 0;
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
                self.smoothed = 0.0;
                self.center = 0.0;
                self.quiet = 0;
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
            } else {
                self.hq.reset();
            }
            self.smoothed = 0.0;
            self.center = 0.0;
            self.quiet = 0;
            self.path = path;
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
        let mut smoothed = self.smoothed;
        let mut center = self.center;
        let mut quiet = self.quiet;
        let snap = |frame: PitchFrame| {
            let corrected = target_hz(frame, values, scale_root, intervals, cents, &mut smoothed, &mut center);
            if corrected <= 0.0 {
                quiet += 1;
                if quiet > 4 {
                    smoothed = 0.0;
                    center = 0.0;
                }
            } else {
                quiet = 0;
            }
            corrected
        };
        if monitoring {
            self.live.process(left, right, frames, snap, sample_rate, min_hz, max_hz, hop, formant);
        } else {
            self.hq.process(left, right, frames, snap, sample_rate, min_hz, max_hz, hop, formant);
        }
        self.smoothed = smoothed;
        self.center = center;
        self.quiet = quiet;
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
    smoothed: &mut f64,
    center: &mut f64,
) -> f64 {
    if frame.hz <= 0.0 || frame.confidence < 0.7 {
        return 0.0;
    }
    let reference = clamp(param(values, 14, 440.0), 430.0, 450.0);
    let midi = 69.0 + 12.0 * (frame.hz / reference).log2() + param(values, 4, 0.0);
    let heard_pc = mod_floor(js_round(midi) as i32, 12);
    let bypass = js_round(param(values, 13, 0.0)) as i32;
    if bypass & (1 << heard_pc) != 0 {
        return 0.0;
    }
    let held = js_round(param(values, 18, -1.0)) as i32;
    let snapped = if (0..=127).contains(&held) {
        held as f64
    } else {
        tune_snap_midi(midi, values, scale_root, intervals, cents)
    };
    let nudge_pc = mod_floor(js_round(snapped) as i32, 12);
    let nudge = clamp(param(values, 19 + nudge_pc as usize, 0.0), -200.0, 200.0) / 100.0;
    let goal = reference * 2f64.powf((snapped + nudge - 69.0) / 12.0);
    let slow = if *center == 0.0 { frame.hz } else { *center };
    *center = slow + (frame.hz - slow) * 0.08;
    let human = clamp(param(values, 1, 0.05), 0.0, 1.0);
    let amount = clamp(param(values, 3, 0.85), 0.0, 1.0);
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
    let speed = clamp(param(values, 0, 0.5), 0.02, 1.0);
    let rate = if classic { (0.35 + speed * 0.65).min(1.0) } else { speed };
    let prev = if *smoothed == 0.0 { frame.hz } else { *smoothed };
    let next = prev + (aimed - prev) * rate;
    *smoothed = next;
    clamp(next, 40.0, 2000.0)
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
