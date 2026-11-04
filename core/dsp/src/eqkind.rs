//! EQ kinds other than the clean five-band processor.

use crate::biquad::{design_biquad, sanitize, tick, Biquad, BiquadKind};
use crate::contract::NativePlugin;
use crate::eq::EqProcessor;
use crate::shaper::AnalogShaper;
use crate::util::{clamp, coeff, db_to_gain, js_or, js_round, param, write_stereo};

const LOW_FREQS: [f64; 4] = [20.0, 30.0, 60.0, 100.0];
const HIGH_FREQS: [f64; 7] = [3000.0, 4000.0, 5000.0, 8000.0, 10000.0, 12000.0, 16000.0];
const HIGH_ATTEN: [f64; 3] = [5000.0, 10000.0, 20000.0];
const PRE_HP: [f64; 5] = [0.0, 50.0, 80.0, 160.0, 300.0];
const PRE_LOW: [f64; 4] = [35.0, 60.0, 110.0, 220.0];
const PRE_MID: [f64; 6] = [360.0, 700.0, 1600.0, 3200.0, 4800.0, 7200.0];
const CHANNEL_LF: [f64; 4] = [60.0, 110.0, 220.0, 360.0];
const CHANNEL_LMF: [f64; 4] = [200.0, 400.0, 800.0, 1500.0];
const CHANNEL_HMF: [f64; 4] = [800.0, 1500.0, 3000.0, 6000.0];
const CHANNEL_HF: [f64; 4] = [6000.0, 8000.0, 12000.0, 16000.0];
const PROP_FREQS: [f64; 11] = [50.0, 80.0, 150.0, 300.0, 500.0, 800.0, 1500.0, 2500.0, 5000.0, 8000.0, 12000.0];

fn step(index: f64, values: &[f64]) -> f64 {
    values[js_round(index).clamp(0.0, (values.len() - 1) as f64) as usize]
}

pub struct EqBank {
    pub clean: EqProcessor,
    passive: [[Biquad; 4]; 2],
    pre: [[Biquad; 4]; 2],
    pre_count: usize,
    pre_shapers: [AnalogShaper; 2],
    channel: [[Biquad; 4]; 2],
    prop: [Biquad; 2],
    focus: [[Biquad; 3]; 2],
    focus_env: f64,
    focus_stamp: [f64; 9],
    focus_ready: bool,
    linear_collect: [Vec<f32>; 2],
    linear_overlap: [Vec<f32>; 2],
    linear_window: Vec<f32>,
    linear_re: [Vec<f64>; 2],
    linear_im: [Vec<f64>; 2],
    linear_out: [Vec<f32>; 2],
    filled: usize,
    read: usize,
    dynamic_detect: [Biquad; 2],
    dynamic_peak: [Biquad; 2],
    dynamic_env: f64,
    dynamic_applied: f64,
    master: [[Biquad; 5]; 2],
    master_key: [f64; 8],
    master_ready: bool,
    fir_kernel: Vec<f32>,
    fir_hist: [Vec<f32>; 2],
    fir_re: Vec<f32>,
    fir_im: Vec<f32>,
    pub latency: u32,
}

impl EqBank {
    pub fn new(sample_rate: f64) -> Self {
        let size = 512;
        let mut window = vec![0.0; size];
        for i in 0..size {
            window[i] = (0.5 - 0.5 * ((2.0 * std::f64::consts::PI * i as f64) / (size as f64 - 1.0)).cos()) as f32;
        }
        Self {
            clean: EqProcessor::new(),
            passive: [[Biquad::default(); 4]; 2],
            pre: [[Biquad::default(); 4]; 2],
            pre_count: 0,
            pre_shapers: [AnalogShaper::new(4), AnalogShaper::new(4)],
            channel: [[Biquad::default(); 4]; 2],
            prop: [Biquad::default(); 2],
            focus: [[Biquad::default(); 3]; 2],
            focus_env: 0.0,
            focus_stamp: [f64::NAN; 9],
            focus_ready: false,
            linear_collect: [vec![0.0; size], vec![0.0; size]],
            linear_overlap: [vec![0.0; size], vec![0.0; size]],
            linear_window: window,
            linear_re: [vec![0.0; size], vec![0.0; size]],
            linear_im: [vec![0.0; size], vec![0.0; size]],
            linear_out: [vec![0.0; size], vec![0.0; size]],
            filled: 0,
            read: 0,
            dynamic_detect: [
                design_biquad(BiquadKind::Bandpass, sample_rate, 3000.0, 1.2, 0.0),
                design_biquad(BiquadKind::Bandpass, sample_rate, 3000.0, 1.2, 0.0),
            ],
            dynamic_peak: [
                design_biquad(BiquadKind::Peaking, sample_rate, 3000.0, 1.2, 0.0),
                design_biquad(BiquadKind::Peaking, sample_rate, 3000.0, 1.2, 0.0),
            ],
            dynamic_env: 0.0,
            dynamic_applied: 999.0,
            master: [[Biquad::default(); 5]; 2],
            master_key: [f64::NAN; 8],
            master_ready: false,
            fir_kernel: vec![0.0; 1024],
            fir_hist: [vec![0.0; 1024], vec![0.0; 1024]],
            fir_re: vec![0.0; 1024],
            fir_im: vec![0.0; 1024],
            latency: 0,
        }
    }

    pub fn prepare_clean(&mut self, sample_rate: f64, max_block: usize) {
        self.clean.prepare(sample_rate, max_block);
    }

    pub fn reset(&mut self) {
        self.clean.reset();
        for bank in [&mut self.passive, &mut self.pre, &mut self.channel] {
            for pair in bank.iter_mut() {
                for filter in pair.iter_mut() {
                    filter.clear_state();
                }
            }
        }
        for filter in &mut self.prop {
            filter.clear_state();
        }
        for bank in &mut self.focus {
            for filter in bank {
                filter.clear_state();
            }
        }
        self.focus_env = 0.0;
        self.filled = 0;
        self.read = 0;
        self.linear_overlap[0].fill(0.0);
        self.linear_overlap[1].fill(0.0);
        self.dynamic_env = 0.0;
        self.dynamic_applied = 999.0;
        for filter in self.dynamic_detect.iter_mut().chain(self.dynamic_peak.iter_mut()) {
            filter.clear_state();
        }
        for bank in &mut self.master {
            for filter in bank {
                filter.clear_state();
            }
        }
        self.master_ready = false;
        self.fir_hist[0].fill(0.0);
        self.fir_hist[1].fill(0.0);
        self.pre_shapers[0].force_factor(4);
        self.pre_shapers[1].force_factor(4);
        self.latency = 0;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool, offline: bool) -> u32 {
        let kind = js_round(param(values, 0, 0.0)).clamp(0.0, 7.0) as i32;
        self.latency = 0;
        match kind {
            1 => self.passive(left, right, frames, values, sample_rate),
            2 => self.preamp(left, right, frames, values, sample_rate, eco),
            3 => self.channel(left, right, frames, values, sample_rate),
            4 => self.prop(left, right, frames, values, sample_rate),
            5 => self.focus(left, right, frames, values, sample_rate, eco),
            6 => self.master(left, right, frames, values, sample_rate, offline),
            7 => self.dynamic(left, right, frames, values, sample_rate),
            _ => {
                self.clean.snap_parameters(values);
                let mut audio = crate::contract::AudioBlock {
                    channels: [left, right],
                    num_channels: 2,
                    num_samples: frames,
                };
                self.clean.process_block(&mut audio, &crate::contract::EMPTY_MIDI);
            }
        }
        self.latency
    }

    fn passive(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let designed = passive_filters(sample_rate, values);
        for (index, filter) in designed.iter().enumerate() {
            self.passive[0][index].copy_coeffs(filter);
            self.passive[1][index].copy_coeffs(filter);
        }
        for i in 0..frames {
            write_stereo(left, right, i, apply(&mut self.passive[0], left[i] as f64), apply(&mut self.passive[1], right[i] as f64));
        }
    }

    fn preamp(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let factor = if eco { 2 } else { 4 };
        if self.pre_shapers[0].factor != factor {
            self.pre_shapers[0].force_factor(factor);
            self.pre_shapers[1].force_factor(factor);
        }
        let (designed, count) = pre_filters(sample_rate, values);
        for index in 0..count {
            self.pre[0][index].copy_coeffs(&designed[index]);
            self.pre[1][index].copy_coeffs(&designed[index]);
        }
        self.pre_count = count;
        let drive = clamp(param(values, 28, 0.0), 0.0, 1.0);
        for i in 0..frames {
            let wet_l = self.pre_shapers[0].oversample(apply_count(&mut self.pre[0], self.pre_count, left[i] as f64), drive);
            let wet_r = self.pre_shapers[1].oversample(apply_count(&mut self.pre[1], self.pre_count, right[i] as f64), drive);
            write_stereo(left, right, i, wet_l, wet_r);
        }
    }

    fn channel(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let designed = channel_filters(sample_rate, values);
        for (index, filter) in designed.iter().enumerate() {
            self.channel[0][index].copy_coeffs(filter);
            self.channel[1][index].copy_coeffs(filter);
        }
        for i in 0..frames {
            write_stereo(left, right, i, apply(&mut self.channel[0], left[i] as f64), apply(&mut self.channel[1], right[i] as f64));
        }
    }

    fn prop(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let gain = clamp(param(values, 39, 0.0), -12.0, 12.0);
        let freq = step(param(values, 38, 5.0), &PROP_FREQS);
        let q = clamp(0.35 + gain.abs() / 7.0, 0.35, 2.4);
        let next = design_biquad(BiquadKind::Peaking, sample_rate, freq, q, gain);
        self.prop[0].copy_coeffs(&next);
        self.prop[1].copy_coeffs(&next);
        for i in 0..frames {
            write_stereo(left, right, i, tick(&mut self.prop[0], left[i] as f64), tick(&mut self.prop[1], right[i] as f64));
        }
    }

    fn focus(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let linear = param(values, 51, 0.0) >= 0.5 && !eco;
        self.latency = if linear { 256 } else { 0 };
        let stamp = [
            param(values, 40, 120.0), param(values, 41, 0.0), param(values, 42, 0.7),
            param(values, 43, 1500.0), param(values, 44, 0.0), param(values, 45, 1.0),
            param(values, 46, 8000.0), param(values, 47, 0.0), param(values, 48, 0.7),
        ];
        if !self.focus_ready || stamp != self.focus_stamp {
            let designed = focus_filters(sample_rate, &stamp);
            for (index, filter) in designed.iter().enumerate() {
                self.focus[0][index] = *filter;
                self.focus[1][index] = *filter;
            }
            self.focus_stamp = stamp;
            self.focus_ready = true;
        }
        let dynamic = clamp(param(values, 49, 0.0), 0.0, 1.0);
        let threshold = db_to_gain(param(values, 50, -18.0));
        if linear {
            self.focus_linear(left, right, frames, sample_rate);
            return;
        }
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let shaped_l = apply(&mut self.focus[0], dry_l);
            let shaped_r = apply(&mut self.focus[1], dry_r);
            let band = shaped_l.abs().max(shaped_r.abs());
            self.focus_env += (band - self.focus_env) * if band > self.focus_env { 0.15 } else { 0.01 };
            let duck = if dynamic > 0.0 && self.focus_env > threshold { dynamic } else { 0.0 };
            let wet = 1.0 - duck;
            write_stereo(left, right, i, dry_l * duck + shaped_l * wet, dry_r * duck + shaped_r * wet);
        }
    }

    fn focus_linear(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, sample_rate: f64) {
        let size = 512;
        for i in 0..frames {
            self.linear_collect[0][self.filled] = left[i];
            self.linear_collect[1][self.filled] = right[i];
            self.filled += 1;
            if self.filled == size {
                for channel in 0..2 {
                    zero_phase(
                        &self.linear_collect[channel],
                        &self.focus[channel],
                        sample_rate,
                        &self.linear_window,
                        &mut self.linear_re[channel],
                        &mut self.linear_im[channel],
                        &mut self.linear_out[channel],
                    );
                    for k in 0..size {
                        let slot = (self.read + k) % size;
                        self.linear_overlap[channel][slot] += self.linear_out[channel][k];
                    }
                    self.linear_collect[channel].copy_within(size / 2..size, 0);
                }
                self.filled = size / 2;
            }
            let out_l = self.linear_overlap[0][self.read % size];
            let out_r = self.linear_overlap[1][self.read % size];
            self.linear_overlap[0][self.read % size] = 0.0;
            self.linear_overlap[1][self.read % size] = 0.0;
            self.read += 1;
            write_stereo(left, right, i, out_l as f64, out_r as f64);
        }
    }

    fn dynamic(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let freq = js_or(param(values, 52, 3000.0), 3000.0);
        let q = js_or(param(values, 53, 1.2), 1.2);
        let amount = param(values, 55, 0.0);
        let threshold = db_to_gain(param(values, 54, -24.0));
        let follow = coeff(js_or(param(values, 56, 10.0), 10.0), sample_rate);
        let release = coeff(js_or(param(values, 57, 80.0), 80.0), sample_rate);
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let det = tick(&mut self.dynamic_detect[0], dry_l).abs().max(tick(&mut self.dynamic_detect[1], dry_r).abs());
            let rate = if det > self.dynamic_env { follow } else { release };
            self.dynamic_env += (det - self.dynamic_env) * rate;
            let active = if self.dynamic_env > threshold { amount } else { 0.0 };
            if (active - self.dynamic_applied).abs() > 0.05 {
                let next = design_biquad(BiquadKind::Peaking, sample_rate, freq, q, active);
                self.dynamic_peak[0].copy_coeffs(&next);
                self.dynamic_peak[1].copy_coeffs(&next);
                let band = design_biquad(BiquadKind::Bandpass, sample_rate, freq, q, 0.0);
                self.dynamic_detect[0].copy_coeffs(&band);
                self.dynamic_detect[1].copy_coeffs(&band);
                self.dynamic_applied = active;
            }
            write_stereo(left, right, i, tick(&mut self.dynamic_peak[0], dry_l), tick(&mut self.dynamic_peak[1], dry_r));
        }
    }

    fn master(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, offline: bool) {
        let heavy = offline && param(values, 12, 1.0) >= 0.5;
        let key = [
            param(values, 1, 20.0),
            param(values, 2, 20000.0),
            param(values, 4, 0.0),
            param(values, 6, 1500.0),
            param(values, 7, 0.0),
            param(values, 8, 1.0),
            param(values, 10, 0.0),
            if heavy { 1.0 } else { 0.0 },
        ];
        if !self.master_ready || key != self.master_key {
            let designed = master_filters(sample_rate, values);
            for (index, filter) in designed.iter().enumerate() {
                self.master[0][index].copy_coeffs(filter);
                self.master[1][index].copy_coeffs(filter);
            }
            if heavy {
                design_linear_kernel(&designed, sample_rate, &mut self.fir_re, &mut self.fir_im, &mut self.fir_kernel);
                self.fir_hist[0].fill(0.0);
                self.fir_hist[1].fill(0.0);
            }
            self.master_key = key;
            self.master_ready = true;
        }
        if heavy {
            self.latency = 511;
            for i in 0..frames {
                let l = fir_tick(&mut self.fir_hist[0], &self.fir_kernel, left[i]);
                let r = fir_tick(&mut self.fir_hist[1], &self.fir_kernel, right[i]);
                left[i] = sanitize(l) as f32;
                right[i] = sanitize(r) as f32;
            }
            return;
        }
        self.latency = 0;
        for i in 0..frames {
            write_stereo(left, right, i, apply(&mut self.master[0], left[i] as f64), apply(&mut self.master[1], right[i] as f64));
        }
    }
}

fn apply(filters: &mut [Biquad], sample: f64) -> f64 {
    let mut value = sample;
    for filter in filters {
        value = tick(filter, value);
    }
    sanitize(value)
}

fn apply_count(filters: &mut [Biquad], count: usize, sample: f64) -> f64 {
    let mut value = sample;
    for filter in filters.iter_mut().take(count) {
        value = tick(filter, value);
    }
    sanitize(value)
}

fn passive_filters(sample_rate: f64, values: &[f64]) -> [Biquad; 4] {
    let low = step(param(values, 13, 2.0), &LOW_FREQS);
    let high = step(param(values, 16, 4.0), &HIGH_FREQS);
    let atten_f = step(param(values, 20, 1.0), &HIGH_ATTEN);
    let boost = clamp(param(values, 14, 0.0), 0.0, 1.0) * 12.0;
    let atten = -clamp(param(values, 15, 0.0), 0.0, 1.0) * 12.0;
    let high_boost = clamp(param(values, 17, 0.0), 0.0, 1.0) * 14.0;
    let bandwidth = clamp(param(values, 18, 0.5), 0.0, 1.0);
    let q = 0.4 + bandwidth * 1.6;
    let high_cut = -clamp(param(values, 19, 0.0), 0.0, 1.0) * 12.0;
    [
        design_biquad(BiquadKind::Peaking, sample_rate, low, 0.9, boost),
        design_biquad(BiquadKind::Lowshelf, sample_rate, low * 3.2, 0.7, atten * 0.7),
        design_biquad(BiquadKind::Peaking, sample_rate, high, q, high_boost),
        design_biquad(BiquadKind::Highshelf, sample_rate, atten_f, 0.7, high_cut),
    ]
}

fn pre_filters(sample_rate: f64, values: &[f64]) -> ([Biquad; 4], usize) {
    let hp = step(param(values, 21, 0.0), &PRE_HP);
    let low_f = step(param(values, 22, 2.0), &PRE_LOW);
    let mid_f = step(param(values, 24, 2.0), &PRE_MID);
    let high_f = if param(values, 26, 0.0) >= 0.5 { 12000.0 } else { 10000.0 };
    let mut filters = [Biquad::default(); 4];
    let mut count = 0;
    if hp > 0.0 {
        filters[count] = design_biquad(BiquadKind::Highpass, sample_rate, hp, 0.7, 0.0);
        count += 1;
    }
    filters[count] = design_biquad(BiquadKind::Lowshelf, sample_rate, low_f, 0.7, clamp(param(values, 23, 0.0), -16.0, 16.0));
    count += 1;
    filters[count] = design_biquad(BiquadKind::Peaking, sample_rate, mid_f, 1.1, clamp(param(values, 25, 0.0), -18.0, 18.0));
    count += 1;
    filters[count] = design_biquad(BiquadKind::Highshelf, sample_rate, high_f, 0.6, clamp(param(values, 27, 0.0), -16.0, 16.0));
    count += 1;
    (filters, count)
}

fn channel_filters(sample_rate: f64, values: &[f64]) -> [Biquad; 4] {
    let curve = param(values, 29, 0.0);
    let q = if curve >= 0.5 { 1.5 } else { 0.65 };
    [
        design_biquad(BiquadKind::Lowshelf, sample_rate, step(param(values, 30, 1.0), &CHANNEL_LF), 0.7, clamp(param(values, 31, 0.0), -15.0, 15.0)),
        design_biquad(BiquadKind::Peaking, sample_rate, step(param(values, 32, 1.0), &CHANNEL_LMF), q, clamp(param(values, 33, 0.0), -15.0, 15.0)),
        design_biquad(BiquadKind::Peaking, sample_rate, step(param(values, 34, 2.0), &CHANNEL_HMF), q, clamp(param(values, 35, 0.0), -15.0, 15.0)),
        design_biquad(BiquadKind::Highshelf, sample_rate, step(param(values, 36, 2.0), &CHANNEL_HF), 0.7, clamp(param(values, 37, 0.0), -15.0, 15.0)),
    ]
}

fn focus_filters(sample_rate: f64, stamp: &[f64]) -> [Biquad; 3] {
    let mut out = [Biquad::default(); 3];
    for band in 0..3 {
        let freq = clamp(stamp[band * 3], 40.0, 16000.0);
        let gain = clamp(stamp[band * 3 + 1], -18.0, 18.0);
        let q = clamp(stamp[band * 3 + 2], 0.2, 12.0);
        out[band] = design_biquad(BiquadKind::Peaking, sample_rate, freq, q, gain);
    }
    out
}

fn design_linear_kernel(filters: &[Biquad], sample_rate: f64, re: &mut [f32], im: &mut [f32], kernel: &mut [f32]) {
    let size = kernel.len().min(re.len()).min(im.len());
    re[..size].fill(0.0);
    im[..size].fill(0.0);
    for k in 0..=size / 2 {
        let freq = (k as f64 * sample_rate) / size as f64;
        let mag = filters.iter().fold(1.0, |gain, filter| gain * biquad_magnitude(filter, freq, sample_rate));
        let safe = if mag.is_finite() { mag.max(0.0) } else { 1.0 };
        re[k] = safe as f32;
        if k > 0 && k < size / 2 {
            re[size - k] = safe as f32;
        }
    }
    fft_f32(&mut re[..size], &mut im[..size], true);
    let half = size / 2;
    for i in 0..size {
        kernel[i] = re[(i + half) % size];
    }
}

fn biquad_magnitude(filter: &Biquad, freq: f64, sample_rate: f64) -> f64 {
    let freq = clamp(freq, 1.0, sample_rate * 0.49);
    let w = (2.0 * std::f64::consts::PI * freq) / sample_rate;
    let c1 = w.cos();
    let s1 = w.sin();
    let c2 = (2.0 * w).cos();
    let s2 = (2.0 * w).sin();
    let br = filter.b0 + filter.b1 * c1 + filter.b2 * c2;
    let bi = -(filter.b1 * s1 + filter.b2 * s2);
    let ar = 1.0 + filter.a1 * c1 + filter.a2 * c2;
    let ai = -(filter.a1 * s1 + filter.a2 * s2);
    let den = ar * ar + ai * ai;
    if den < 1e-18 {
        return 1.0;
    }
    ((br * br + bi * bi) / den).sqrt()
}

fn fir_tick(hist: &mut [f32], kernel: &[f32], sample: f32) -> f64 {
    let taps = hist.len();
    hist.copy_within(1..taps, 0);
    hist[taps - 1] = sample;
    let mut acc = 0.0;
    for k in 0..taps {
        acc += hist[k] as f64 * kernel[k] as f64;
    }
    acc
}

fn fft_f32(real: &mut [f32], imag: &mut [f32], inverse: bool) {
    let n = real.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            real.swap(i, j);
            imag.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = (2.0 * std::f64::consts::PI / len as f64) * if inverse { 1.0 } else { -1.0 };
        let wlen_r = ang.cos();
        let wlen_i = ang.sin();
        let mut i = 0;
        while i < n {
            let mut wr = 1.0f64;
            let mut wi = 0.0f64;
            let half = len >> 1;
            for j in 0..half {
                let ur = real[i + j] as f64;
                let ui = imag[i + j] as f64;
                let vr = real[i + j + half] as f64 * wr - imag[i + j + half] as f64 * wi;
                let vi = real[i + j + half] as f64 * wi + imag[i + j + half] as f64 * wr;
                real[i + j] = (ur + vr) as f32;
                imag[i + j] = (ui + vi) as f32;
                real[i + j + half] = (ur - vr) as f32;
                imag[i + j + half] = (ui - vi) as f32;
                let next_r = wr * wlen_r - wi * wlen_i;
                wi = wr * wlen_i + wi * wlen_r;
                wr = next_r;
            }
            i += len;
        }
        len <<= 1;
    }
    if inverse {
        let scale = n as f64;
        for i in 0..n {
            real[i] = (real[i] as f64 / scale) as f32;
            imag[i] = (imag[i] as f64 / scale) as f32;
        }
    }
}

fn master_filters(sample_rate: f64, values: &[f64]) -> [Biquad; 5] {
    [
        design_biquad(BiquadKind::Highpass, sample_rate, js_or(param(values, 1, 30.0), 30.0), 0.707, 0.0),
        design_biquad(BiquadKind::Lowshelf, sample_rate, 140.0, 0.7, param(values, 4, 0.0), ),
        design_biquad(BiquadKind::Peaking, sample_rate, js_or(param(values, 6, 1200.0), 1200.0), js_or(param(values, 8, 1.0), 1.0), param(values, 7, 0.0)),
        design_biquad(BiquadKind::Highshelf, sample_rate, 8000.0, 0.7, param(values, 10, 0.0)),
        design_biquad(BiquadKind::Lowpass, sample_rate, js_or(param(values, 2, 19000.0), 19000.0), 0.707, 0.0),
    ]
}

fn zero_phase(frame: &[f32], filters: &[Biquad], sample_rate: f64, window: &[f32], re: &mut [f64], im: &mut [f64], out: &mut [f32]) {
    let n = frame.len();
    re.fill(0.0);
    im.fill(0.0);
    for i in 0..n {
        re[i] = frame[i] as f64 * window[i] as f64;
    }
    fft(re, im, false);
    for bin in 0..=n / 2 {
        let freq = (bin as f64 * sample_rate) / n as f64;
        let mag = 10f64.powf(cascade_db(filters, freq.max(20.0), sample_rate) / 20.0);
        re[bin] *= mag;
        im[bin] *= mag;
        if bin > 0 && bin < n / 2 {
            re[n - bin] *= mag;
            im[n - bin] *= mag;
        }
    }
    fft(re, im, true);
    for i in 0..n {
        out[i] = (re[i] * window[i] as f64) as f32;
    }
}

fn cascade_db(filters: &[Biquad], freq: f64, sample_rate: f64) -> f64 {
    filters.iter().map(|filter| response_db(filter, freq, sample_rate)).sum()
}

fn response_db(filter: &Biquad, freq: f64, sample_rate: f64) -> f64 {
    let w = (2.0 * std::f64::consts::PI * freq) / sample_rate;
    let c1 = w.cos();
    let s1 = w.sin();
    let c2 = (2.0 * w).cos();
    let s2 = (2.0 * w).sin();
    let num_re = filter.b0 + filter.b1 * c1 + filter.b2 * c2;
    let num_im = -(filter.b1 * s1 + filter.b2 * s2);
    let den_re = 1.0 + filter.a1 * c1 + filter.a2 * c2;
    let den_im = -(filter.a1 * s1 + filter.a2 * s2);
    20.0 * (num_re.hypot(num_im) / den_re.hypot(den_im).max(1e-12)).log10()
}

fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = (2.0 * std::f64::consts::PI / len as f64) * if inverse { 1.0 } else { -1.0 };
        let wlen_re = ang.cos();
        let wlen_im = ang.sin();
        let mut i = 0;
        while i < n {
            let mut wr = 1.0;
            let mut wi = 0.0;
            let half = len >> 1;
            for j in 0..half {
                let ur = re[i + j];
                let ui = im[i + j];
                let vr = re[i + j + half] * wr - im[i + j + half] * wi;
                let vi = re[i + j + half] * wi + im[i + j + half] * wr;
                re[i + j] = ur + vr;
                im[i + j] = ui + vi;
                re[i + j + half] = ur - vr;
                im[i + j + half] = ui - vi;
                let next = wr * wlen_re - wi * wlen_im;
                wi = wr * wlen_im + wi * wlen_re;
                wr = next;
            }
            i += len;
        }
        len <<= 1;
    }
    if inverse {
        for i in 0..n {
            re[i] /= n as f64;
            im[i] /= n as f64;
        }
    }
}
