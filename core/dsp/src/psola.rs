//! YIN + PSOLA from `src/audio/stretch/voice.ts`. Ring memory is f32, matching
//! the TypeScript `Float32Array` grain buffers.

use crate::biquad::sanitize;
use crate::util::{clamp, js_round};

#[derive(Clone, Copy)]
pub struct PitchFrame {
    pub hz: f64,
    pub confidence: f64,
}

pub struct Psola {
    channels: usize,
    span: usize,
    live_hop: usize,
    live_ahead: usize,
    pub latency_samples: u32,
    ring: [Vec<f32>; 2],
    mix: [Vec<f32>; 2],
    weight: Vec<f32>,
    frame: Vec<f32>,
    diff: Vec<f32>,
    cmnd: Vec<f32>,
    held: [f32; 2],
    written: i64,
    next_out: i64,
    emitted: i64,
    epoch: i64,
    epoch_set: bool,
    formant: f64,
}

impl Psola {
    pub fn new(sample_rate: f64, live_hop: usize) -> Self {
        let span = (1536.0 * (sample_rate / 48_000.0)).round().max(1024.0) as usize;
        let live_hop = if live_hop > 0 { live_hop } else { 0 };
        let max_half = (span - 1) / 2;
        let live_ahead = if live_hop > 0 { live_hop.max(max_half) } else { 0 };
        let latency_samples = if live_hop > 0 {
            (live_ahead + live_hop) as u32
        } else {
            (span + span / 2) as u32
        };
        let size = span * 8;
        let yin = span / 2 + 1;
        Self {
            channels: 2,
            span,
            live_hop,
            live_ahead,
            latency_samples,
            ring: [vec![0.0; size], vec![0.0; size]],
            mix: [vec![0.0; size], vec![0.0; size]],
            weight: vec![0.0; size],
            frame: vec![0.0; span],
            diff: vec![0.0; yin],
            cmnd: vec![0.0; yin],
            held: [0.0; 2],
            written: 0,
            next_out: 0,
            emitted: 0,
            epoch: 0,
            epoch_set: false,
            formant: 0.0,
        }
    }

    pub fn reset(&mut self) {
        for buffer in &mut self.ring {
            buffer.fill(0.0);
        }
        for buffer in &mut self.mix {
            buffer.fill(0.0);
        }
        self.weight.fill(0.0);
        self.written = 0;
        self.next_out = 0;
        self.emitted = 0;
        self.epoch = 0;
        self.epoch_set = false;
    }

    pub fn process(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
        frames: usize,
        mut target_for: impl FnMut(PitchFrame) -> f64,
        sample_rate: f64,
        min_hz: f64,
        max_hz: f64,
        analyze_every: f64,
        formant: f64,
    ) {
        let hop = js_round(analyze_every).max(32.0) as usize;
        self.formant = clamp(formant, 0.0, 1.0);
        let frames = frames.min(left.len()).min(right.len());
        for i in 0..frames {
            let in_l = left[i];
            let in_r = right[i];
            let slot = (self.written as usize) % self.ring[0].len();
            self.ring[0][slot] = in_l;
            self.ring[1][slot] = in_r;
            self.written += 1;
            self.synthesize(&mut target_for, sample_rate, min_hz, max_hz, hop);
            self.take(hop);
            left[i] = self.held[0];
            right[i] = self.held[1];
        }
    }

    fn synthesize(
        &mut self,
        target_for: &mut impl FnMut(PitchFrame) -> f64,
        sample_rate: f64,
        min_hz: f64,
        max_hz: f64,
        hop: usize,
    ) {
        let mut guard = 0;
        let ahead = if self.live_hop > 0 { self.live_ahead as i64 } else { self.span as i64 };
        let guard_max = if self.live_hop > 0 { 8 } else { 4 };
        while self.written - self.next_out > ahead && guard < guard_max {
            guard += 1;
            for i in 0..self.span {
                self.frame[i] = self.read(0, self.next_out - self.span as i64 + i as i64);
            }
            let pitch = yin_pitch(&self.frame, sample_rate, min_hz, max_hz, &mut self.diff, &mut self.cmnd);
            let target = target_for(pitch);
            let voiced = pitch.hz > 0.0 && pitch.confidence >= 0.7 && target > 30.0;
            if !voiced {
                self.epoch_set = false;
                self.stamp(self.next_out, self.next_out, hop, false, 1.0);
                self.next_out += hop as i64;
                continue;
            }
            let period = js_round(sample_rate / pitch.hz).clamp(8.0, (self.span / 2) as f64) as i64;
            let out_period = js_round(sample_rate / target).clamp(8.0, (self.span / 2) as f64) as i64;
            if !self.epoch_set {
                self.epoch = self.next_out;
                self.epoch_set = true;
            }
            let steps = js_round((self.next_out - self.epoch) as f64 / period as f64) as i64;
            let mark = self.epoch + steps * period;
            let grain = (period * 2).clamp(16, self.span as i64 - 1) as usize;
            let ratio = if pitch.hz > 0.0 { target / pitch.hz } else { 1.0 };
            let step = if self.formant > 0.001 {
                1.0 + self.formant * (ratio - 1.0)
            } else {
                1.0
            };
            self.stamp(mark, self.next_out, grain, true, step);
            self.next_out += out_period;
        }
    }

    fn stamp(&mut self, input_center: i64, output_center: i64, grain: usize, windowed: bool, step: f64) {
        let half = (grain / 2) as i64;
        let center = self.fit_center(input_center, half, step);
        let len = self.weight.len();
        for i in 0..grain {
            let at = output_center - half + i as i64;
            if at < self.emitted {
                continue;
            }
            let win = if windowed { hann(i, grain) } else { 1.0 };
            let slot = (at as usize) % len;
            self.weight[slot] = (self.weight[slot] as f64 + win) as f32;
            let at_input = center as f64 + (i as f64 - half as f64) * step;
            for c in 0..self.channels {
                let sample = if step == 1.0 {
                    self.read(c, at_input as i64) as f64
                } else {
                    self.read_frac(c, at_input)
                };
                let mixed = self.mix[c][slot] as f64 + sample * win;
                self.mix[c][slot] = mixed as f32;
            }
        }
    }

    fn fit_center(&self, input_center: i64, half: i64, step: f64) -> i64 {
        let reach = (half as f64 * step.max(1.0)).ceil() as i64;
        let latest = self.written - 1 - reach;
        if latest < 0 || input_center <= latest {
            input_center
        } else {
            latest
        }
    }

    fn take(&mut self, hop: usize) {
        let delay = if self.live_hop > 0 {
            self.live_hop as i64
        } else {
            (hop as i64).max((self.span / 2) as i64)
        };
        let ready = self.next_out - delay;
        if self.emitted >= ready {
            self.held = [0.0; 2];
            return;
        }
        let slot = (self.emitted as usize) % self.weight.len();
        let weight = self.weight[slot];
        for c in 0..self.channels {
            let sample = if weight > 1e-5 {
                self.mix[c][slot] / weight
            } else {
                0.0
            };
            self.held[c] = sanitize(sample as f64) as f32;
            self.mix[c][slot] = 0.0;
        }
        self.held[1] = if self.channels == 1 { self.held[0] } else { self.held[1] };
        self.weight[slot] = 0.0;
        self.emitted += 1;
    }

    fn read(&self, channel: usize, index: i64) -> f32 {
        if index < 0 || index >= self.written {
            return 0.0;
        }
        let len = self.ring[channel].len();
        self.ring[channel][(index as usize) % len]
    }

    fn read_frac(&self, channel: usize, index: f64) -> f64 {
        let base = index.floor() as i64;
        let frac = index - base as f64;
        let a = self.read(channel, base) as f64;
        if frac <= 0.0 {
            return a;
        }
        let b = self.read(channel, base + 1) as f64;
        a + (b - a) * frac
    }
}

fn hann(index: usize, length: usize) -> f64 {
    if length <= 1 {
        return 1.0;
    }
    0.5 - 0.5 * ((2.0 * std::f64::consts::PI * index as f64) / (length as f64 - 1.0)).cos()
}

fn yin_pitch(frame: &[f32], sample_rate: f64, min_hz: f64, max_hz: f64, diff: &mut [f32], cmnd: &mut [f32]) -> PitchFrame {
    let n = frame.len();
    let tau_min = (sample_rate / max_hz.max(40.0)).floor().max(2.0) as usize;
    let tau_max_cap = (sample_rate / min_hz.max(40.0)).floor() as usize;
    let tau_max = ((n / 2).saturating_sub(2)).min(tau_max_cap);
    if tau_max <= tau_min + 2 {
        return PitchFrame { hz: 0.0, confidence: 0.0 };
    }
    let mut energy = 0.0;
    for sample in frame.iter().take(n) {
        energy += (*sample as f64) * (*sample as f64);
    }
    if energy / (n as f64) < 1e-8 {
        return PitchFrame { hz: 0.0, confidence: 0.0 };
    }
    for tau in 0..=tau_max {
        diff[tau] = 0.0;
        cmnd[tau] = 0.0;
    }
    for tau in tau_min..=tau_max {
        let mut sum = 0.0;
        let mut i = 0;
        while i < n - tau {
            let delta = frame[i] as f64 - frame[i + tau] as f64;
            sum += delta * delta;
            i += 2;
        }
        diff[tau] = sum as f32;
    }
    let mut running = 0.0;
    cmnd[tau_min] = 1.0;
    for tau in tau_min..=tau_max {
        running += diff[tau] as f64;
        cmnd[tau] = if running > 0.0 {
            ((diff[tau] as f64) * tau as f64 / running) as f32
        } else {
            1.0
        };
    }
    let mut tau = -1isize;
    let mut t = tau_min;
    while t <= tau_max {
        if (cmnd[t] as f64) < 0.18 {
            while t + 1 <= tau_max && cmnd[t + 1] < cmnd[t] {
                t += 1;
            }
            tau = t as isize;
            break;
        }
        t += 1;
    }
    if tau < 0 {
        let mut best = tau_min;
        for t in (tau_min + 1)..=tau_max {
            if cmnd[t] < cmnd[best] {
                best = t;
            }
        }
        if cmnd[best] as f64 > 0.5 {
            return PitchFrame {
                hz: 0.0,
                confidence: clamp01(1.0 - cmnd[best] as f64),
            };
        }
        tau = best as isize;
    }
    let tau = tau as usize;
    let prev = cmnd[tau.saturating_sub(1)] as f64;
    let mid = cmnd[tau] as f64;
    let next = cmnd[(tau + 1).min(tau_max)] as f64;
    let denom = prev + next - 2.0 * mid;
    let shift = if denom == 0.0 { 0.0 } else { (prev - next) / (2.0 * denom) };
    let period = (tau as f64 + shift).max(1.0);
    PitchFrame {
        hz: sample_rate / period,
        confidence: clamp01(1.0 - mid),
    }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}
