//! Master limiter kinds: transparent, brick, and loud, plus the imager in front.

use crate::biquad::{design_biquad, tick, Biquad, BiquadKind};
use crate::resample::{Downsampler, Upsampler};
use crate::util::{clamp, coeff, db_to_gain, gain_to_db, js_or, js_round, param, write_stereo};

pub struct CleanLimiter {
    delay: [Vec<f32>; 2],
    index: usize,
    gain: f64,
}

impl CleanLimiter {
    pub fn new() -> Self {
        Self { delay: [vec![0.0; 64], vec![0.0; 64]], index: 0, gain: 1.0 }
    }
    pub fn reset(&mut self) {
        self.delay[0].fill(0.0);
        self.delay[1].fill(0.0);
        self.index = 0;
        self.gain = 1.0;
    }
    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let ceiling = db_to_gain(param(values, 3, -0.1));
        let threshold = db_to_gain(param(values, 1, 0.0));
        let release = coeff(js_or(param(values, 2, 50.0), 40.0), sample_rate);
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let slot = self.index % 64;
            let out_l = self.delay[0][slot] as f64;
            let out_r = self.delay[1][slot] as f64;
            self.delay[0][slot] = dry_l as f32;
            self.delay[1][slot] = dry_r as f32;
            let mut peak = dry_l.abs().max(dry_r.abs());
            for k in 0..64 {
                peak = peak.max((self.delay[0][k] as f64).abs()).max((self.delay[1][k] as f64).abs());
            }
            let needed = (ceiling / peak.max(threshold).max(1e-8)).min(1.0);
            self.gain += (needed - self.gain) * if needed < self.gain { 1.0 } else { release };
            self.index += 1;
            write_stereo(left, right, i, out_l * self.gain, out_r * self.gain);
        }
    }
}

struct Brick {
    factor: usize,
    look: usize,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    index: usize,
    gain: f64,
    peak: f64,
    since: usize,
    up_l: Upsampler,
    up_r: Upsampler,
    down_l: Downsampler,
    down_r: Downsampler,
    high_l: Vec<f32>,
    high_r: Vec<f32>,
    lim_l: Vec<f32>,
    lim_r: Vec<f32>,
    ready: bool,
}

impl Brick {
    fn new(factor: usize, taps: usize) -> Self {
        Self {
            factor,
            look: 8,
            delay_l: vec![0.0; 8192],
            delay_r: vec![0.0; 8192],
            index: 0,
            gain: 1.0,
            peak: 1e-8,
            since: 0,
            up_l: Upsampler::new(factor, taps),
            up_r: Upsampler::new(factor, taps),
            down_l: Downsampler::new(factor, taps),
            down_r: Downsampler::new(factor, taps),
            high_l: vec![0.0; 8192 * 4],
            high_r: vec![0.0; 8192 * 4],
            lim_l: vec![0.0; 8192 * 4],
            lim_r: vec![0.0; 8192 * 4],
            ready: false,
        }
    }
    fn reset_state(&mut self) {
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.index = 0;
        self.gain = 1.0;
        self.peak = 1e-8;
        self.since = 0;
        self.up_l.reset();
        self.up_r.reset();
        self.down_l.reset();
        self.down_r.reset();
        self.ready = false;
    }
    fn ensure(&mut self, sample_rate: f64, lookahead_ms: f64) {
        if self.ready {
            return;
        }
        let look = js_round((lookahead_ms / 1000.0) * sample_rate * self.factor as f64).max(8.0) as usize;
        self.look = look.min(self.delay_l.len());
        self.ready = true;
    }
    fn latency(&self) -> f64 {
        self.look as f64 / self.factor as f64 + self.up_l.latency()
    }
    fn process(&mut self, left: &[f32], right: &[f32], out_l: &mut [f32], out_r: &mut [f32], frames: usize, ceiling: f64, release: f64) {
        let count = frames * self.factor;
        let count = count.min(self.high_l.len());
        self.up_l.upsample_into(left, frames, &mut self.high_l[..count], |sample| sample);
        self.up_r.upsample_into(right, frames, &mut self.high_r[..count], |sample| sample);
        for i in 0..count {
            let in_l = self.high_l[i] as f64;
            let in_r = self.high_r[i] as f64;
            let (l, r) = self.limit_high(in_l, in_r, ceiling, release);
            self.lim_l[i] = l as f32;
            self.lim_r[i] = r as f32;
        }
        self.down_l.process(&self.lim_l[..count], &mut out_l[..frames]);
        self.down_r.process(&self.lim_r[..count], &mut out_r[..frames]);
    }
    fn process_inplace(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, ceiling: f64, release: f64) {
        let count = (frames * self.factor).min(self.high_l.len());
        self.up_l.upsample_into(left, frames, &mut self.high_l[..count], |sample| sample);
        self.up_r.upsample_into(right, frames, &mut self.high_r[..count], |sample| sample);
        for i in 0..count {
            let in_l = self.high_l[i] as f64;
            let in_r = self.high_r[i] as f64;
            let (l, r) = self.limit_high(in_l, in_r, ceiling, release);
            self.lim_l[i] = l as f32;
            self.lim_r[i] = r as f32;
        }
        self.down_l.process(&self.lim_l[..count], &mut left[..frames]);
        self.down_r.process(&self.lim_r[..count], &mut right[..frames]);
    }
    fn limit_high(&mut self, left: f64, right: f64, ceiling: f64, release: f64) -> (f64, f64) {
        let slot = self.index % self.look;
        let out_l = self.delay_l[slot] as f64;
        let out_r = self.delay_r[slot] as f64;
        self.delay_l[slot] = left as f32;
        self.delay_r[slot] = right as f32;
        let entered = left.abs().max(right.abs());
        if entered >= self.peak {
            self.peak = entered;
            self.since = 0;
        } else if self.since >= self.look {
            let mut peak = 1e-8_f64;
            for k in 0..self.look {
                peak = peak.max((self.delay_l[k] as f64).abs()).max((self.delay_r[k] as f64).abs());
            }
            self.peak = peak;
            self.since = 0;
        } else {
            self.since += 1;
        }
        let needed = (ceiling / self.peak.max(1e-8)).min(1.0);
        if needed < self.gain {
            self.gain = needed;
        } else {
            self.gain += (needed - self.gain) * release;
        }
        self.index += 1;
        (out_l * self.gain, out_r * self.gain)
    }
}

struct Meter {
    shelf_l: Biquad,
    hp_l: Biquad,
    shelf_r: Biquad,
    hp_r: Biquad,
    block: f64,
    block_samples: usize,
    energies: Vec<f64>,
    short: Vec<f64>,
    scratch: Vec<f64>,
    integrated: f64,
}

impl Meter {
    fn new(sample_rate: f64) -> Self {
        let (shelf_l, hp_l) = k_weight(sample_rate);
        let (shelf_r, hp_r) = k_weight(sample_rate);
        Self {
            shelf_l,
            hp_l,
            shelf_r,
            hp_r,
            block: 0.0,
            block_samples: 0,
            energies: Vec::with_capacity(18000),
            short: Vec::with_capacity(4000),
            scratch: Vec::with_capacity(4000),
            integrated: -70.0,
        }
    }
    fn reset(&mut self) {
        self.shelf_l.clear_state();
        self.hp_l.clear_state();
        self.shelf_r.clear_state();
        self.hp_r.clear_state();
        self.block = 0.0;
        self.block_samples = 0;
        self.energies.clear();
        self.short.clear();
        self.integrated = -70.0;
    }
    fn feed(&mut self, left: &[f32], right: &[f32], sample_rate: f64) {
        let hop = js_round(0.1 * sample_rate).max(1.0) as usize;
        let n = left.len().min(right.len());
        for i in 0..n {
            let l = left[i] as f64;
            let r = right[i] as f64;
            let wl = tick(&mut self.hp_l, tick(&mut self.shelf_l, l));
            let wr = tick(&mut self.hp_r, tick(&mut self.shelf_r, r));
            self.block += wl * wl + wr * wr;
            self.block_samples += 1;
            if self.block_samples >= hop {
                if self.energies.len() == self.energies.capacity() {
                    self.energies.remove(0);
                }
                self.energies.push(self.block / self.block_samples as f64);
                self.block = 0.0;
                self.block_samples = 0;
            }
        }
        self.integrated = to_lufs(gated_mean(&self.energies, 10.0));
        if !self.energies.is_empty() && self.energies.len() % 10 == 0 {
            if self.short.len() == self.short.capacity() {
                self.short.remove(0);
            }
            let short_blocks = 30.min(self.energies.len());
            let start = self.energies.len() - short_blocks;
            let mut sum = 0.0;
            for value in &self.energies[start..] {
                sum += *value;
            }
            self.short.push(to_lufs(sum / short_blocks as f64));
        }
    }
}

fn k_weight(sample_rate: f64) -> (Biquad, Biquad) {
    let f0 = 1681.974450955533;
    let gain = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (std::f64::consts::PI * f0 / sample_rate).tan();
    let vh = 10f64.powf(gain / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b0: (vh + (vb * k) / q + k * k) / a0,
        b1: (2.0 * (k * k - vh)) / a0,
        b2: (vh - (vb * k) / q + k * k) / a0,
        a1: (2.0 * (k * k - 1.0)) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        ..Biquad::default()
    };
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (std::f64::consts::PI * f0 / sample_rate).tan();
    let a0 = 1.0 + k / q + k * k;
    let high = Biquad {
        b0: 1.0 / a0,
        b1: -2.0 / a0,
        b2: 1.0 / a0,
        a1: (2.0 * (k * k - 1.0)) / a0,
        a2: (1.0 - k / q + k * k) / a0,
        ..Biquad::default()
    };
    (shelf, high)
}

fn to_lufs(mean_square: f64) -> f64 {
    if mean_square <= 1e-12 { -70.0 } else { -0.691 + 10.0 * mean_square.log10() }
}

fn gated_mean(values: &[f64], relative_lu: f64) -> f64 {
    let mut count = 0.0;
    let mut sum = 0.0;
    for value in values {
        if to_lufs(*value) > -70.0 {
            sum += *value;
            count += 1.0;
        }
    }
    if count == 0.0 {
        return 0.0;
    }
    let absolute = sum / count;
    let relative = to_lufs(absolute) - relative_lu;
    let mut count2 = 0.0;
    let mut sum2 = 0.0;
    for value in values {
        let lufs = to_lufs(*value);
        if lufs > -70.0 && lufs >= relative {
            sum2 += *value;
            count2 += 1.0;
        }
    }
    if count2 == 0.0 { absolute } else { sum2 / count2 }
}

pub struct LimitBank {
    clean: CleanLimiter,
    live: Brick,
    offline: Brick,
    live_on: bool,
    maxim_meter: Meter,
    maxim_gain: f64,
    maxim_brick: Brick,
    maxim_live: bool,
    bass: [Biquad; 2],
    split: [Biquad; 2],
    bass_freq: f64,
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
    pub latency: u32,
}

impl LimitBank {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            clean: CleanLimiter::new(),
            live: Brick::new(2, 32),
            offline: Brick::new(4, 48),
            live_on: true,
            maxim_meter: Meter::new(sample_rate),
            maxim_gain: 1.0,
            maxim_brick: Brick::new(2, 32),
            maxim_live: true,
            bass: [
                design_biquad(BiquadKind::Highpass, sample_rate, 120.0, 0.707, 0.0),
                design_biquad(BiquadKind::Highpass, sample_rate, 120.0, 0.707, 0.0),
            ],
            split: [
                design_biquad(BiquadKind::Lowpass, sample_rate, 2000.0, 0.707, 0.0),
                design_biquad(BiquadKind::Lowpass, sample_rate, 2000.0, 0.707, 0.0),
            ],
            bass_freq: 0.0,
            scratch_l: vec![0.0; 8192],
            scratch_r: vec![0.0; 8192],
            latency: 64,
        }
    }
    pub fn reset(&mut self) {
        self.clean.reset();
        self.live.reset_state();
        self.offline.reset_state();
        self.maxim_brick.reset_state();
        self.maxim_meter.reset();
        self.maxim_gain = 1.0;
        self.live_on = true;
        self.maxim_live = true;
        for filter in self.bass.iter_mut().chain(self.split.iter_mut()) {
            filter.clear_state();
        }
        self.bass_freq = 0.0;
        self.latency = 64;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, offline: bool) {
        let frames = frames.min(self.scratch_l.len());
        let kind = js_round(param(values, 0, 0.0)) as i32;
        let wide = (param(values, 7, 1.0) - 1.0).abs() > 0.001
            || (param(values, 9, 1.0) - 1.0).abs() > 0.001
            || (param(values, 10, 1.0) - 1.0).abs() > 0.001;
        if wide {
            self.image(left, right, frames, values, sample_rate);
        }
        if kind == 2 {
            self.maxim(left, right, frames, values, sample_rate, offline);
        }
        if kind >= 1 {
            self.brick(left, right, frames, values, sample_rate, offline);
        } else {
            self.clean.process(left, right, frames, values, sample_rate);
            self.latency = 64;
        }
        let _ = (param(values, 11, 24.0), param(values, 12, 0.0));
    }

    fn image(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let cutoff = js_or(param(values, 8, 120.0), 120.0);
        if cutoff != self.bass_freq {
            let next = design_biquad(BiquadKind::Highpass, sample_rate, cutoff, 0.707, 0.0);
            self.bass[0].copy_coeffs(&next);
            self.bass[1].copy_coeffs(&next);
            self.bass_freq = cutoff;
        }
        let width = param(values, 7, 1.0);
        let low = param(values, 9, 1.0);
        let high = param(values, 10, 1.0);
        for i in 0..frames {
            let l = left[i] as f64;
            let r = right[i] as f64;
            let mid = (l + r) * 0.5;
            let mut side = (l - r) * 0.5;
            side = tick(&mut self.bass[0], side);
            let bottom = tick(&mut self.split[0], side);
            let top = side - bottom;
            side = (bottom * low + top * high) * width;
            write_stereo(left, right, i, mid + side, mid - side);
        }
    }

    fn brick(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, offline: bool) {
        let lookahead = js_or(param(values, 4, 5.0), 5.0);
        let mode = js_round(param(values, 5, 1.0));
        let release_ms = if mode <= 0.0 {
            40.0
        } else if mode >= 2.0 {
            180.0
        } else {
            js_or(param(values, 2, 80.0), 80.0)
        };
        let margin = if offline { 0.25 } else { 0.6 };
        let ceiling = db_to_gain(param(values, 3, -1.0) - margin);
        let brick = if offline { &mut self.offline } else { &mut self.live };
        brick.ensure(sample_rate, lookahead);
        let release = coeff(release_ms, sample_rate * brick.factor as f64);
        self.latency = js_round(brick.latency()) as u32;
        brick.process_inplace(left, right, frames, ceiling, release);
    }

    fn maxim(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, offline: bool) {
        self.maxim_meter.feed(&left[..frames], &right[..frames], sample_rate);
        let target = param(values, 6, -14.0);
        if self.maxim_meter.integrated > -60.0 {
            let desired = db_to_gain(target - self.maxim_meter.integrated);
            self.maxim_gain += (desired - self.maxim_gain) * 0.02;
        }
        for i in 0..frames {
            left[i] = (left[i] as f64 * self.maxim_gain) as f32;
            right[i] = (right[i] as f64 * self.maxim_gain) as f32;
        }
        let ceiling = db_to_gain(param(values, 3, -1.0) - if offline { 0.25 } else { 0.6 });
        let release = coeff(80.0, sample_rate * if offline { 4.0 } else { 2.0 });
        if !offline {
            self.maxim_brick.ensure(sample_rate, 5.0);
            self.maxim_brick.process_inplace(left, right, frames, ceiling, release);
        }
    }
}
