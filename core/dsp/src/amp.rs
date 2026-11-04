//! Amp kind of the saturator. Pedal slots stay on the catalog defaults (tuner / empty),
//! which the TypeScript chain skips. The voiced path is the amp, tone stack, and cabinet.

use crate::biquad::{design_biquad, tick, Biquad, BiquadKind};
use crate::util::{clamp, js_round, param, store};

const HPF: [f64; 9] = [80.0, 90.0, 120.0, 70.0, 85.0, 140.0, 32.0, 40.0, 48.0];
const DRIVE: [f64; 9] = [2.4, 7.0, 16.0, 6.0, 4.2, 1.2, 5.0, 1.6, 12.0];
const BUTTER_Q: [f64; 4] = [2.5629154477, 0.8999762231, 0.6013448869, 0.5097955791];
const CAB_MODES: [[(f64, f64, f64); 4]; 9] = [
    [(98.0, 18.0, 0.7), (240.0, 28.0, 0.45), (980.0, 40.0, 0.28), (2800.0, 70.0, 0.16)],
    [(110.0, 16.0, 0.75), (360.0, 30.0, 0.4), (1400.0, 48.0, 0.22), (3200.0, 80.0, 0.12)],
    [(90.0, 14.0, 0.8), (420.0, 26.0, 0.5), (1800.0, 50.0, 0.2), (3500.0, 90.0, 0.14)],
    [(140.0, 22.0, 0.6), (700.0, 36.0, 0.35), (2200.0, 60.0, 0.22), (4100.0, 95.0, 0.1)],
    [(85.0, 12.0, 0.85), (300.0, 24.0, 0.4), (900.0, 40.0, 0.18), (2400.0, 70.0, 0.08)],
    [(180.0, 20.0, 0.55), (420.0, 28.0, 0.4), (1600.0, 46.0, 0.25), (3600.0, 72.0, 0.18)],
    [(60.0, 12.0, 0.9), (140.0, 18.0, 0.5), (480.0, 34.0, 0.22), (1400.0, 60.0, 0.08)],
    [(70.0, 14.0, 0.85), (180.0, 22.0, 0.45), (620.0, 38.0, 0.2), (1800.0, 66.0, 0.1)],
    [(48.0, 10.0, 0.95), (120.0, 16.0, 0.5), (360.0, 30.0, 0.22), (1100.0, 55.0, 0.08)],
];

struct Os {
    up: [Biquad; 4],
    down: [Biquad; 4],
    dc_x: f64,
    dc_y: f64,
    factor: usize,
    rate: f64,
}

impl Os {
    fn new(sample_rate: f64, factor: usize) -> Self {
        let mut os = Self { up: [Biquad::default(); 4], down: [Biquad::default(); 4], dc_x: 0.0, dc_y: 0.0, factor: 0, rate: 0.0 };
        os.ensure(sample_rate, factor);
        os
    }
    fn ensure(&mut self, sample_rate: f64, factor: usize) {
        if self.factor == factor && self.rate == sample_rate {
            return;
        }
        let os_rate = sample_rate * factor as f64;
        let cutoff = (sample_rate * 0.42).min(10000.0);
        for (index, q) in BUTTER_Q.iter().enumerate() {
            self.up[index] = design_biquad(BiquadKind::Lowpass, os_rate, cutoff, *q, 0.0);
            self.down[index] = design_biquad(BiquadKind::Lowpass, os_rate, cutoff, *q, 0.0);
        }
        self.dc_x = 0.0;
        self.dc_y = 0.0;
        self.factor = factor;
        self.rate = sample_rate;
    }
    fn shape(&mut self, x: f64, model: usize, gain: f64) -> f64 {
        let mut y = 0.0;
        for k in 0..self.factor {
            let mut s = if k == 0 { x * self.factor as f64 } else { 0.0 };
            for filter in &mut self.up {
                s = tick(filter, s);
            }
            s = shape_sample(model, s, gain);
            for filter in &mut self.down {
                s = tick(filter, s);
            }
            y = s;
        }
        let dc = y - self.dc_x + 0.995 * self.dc_y;
        self.dc_x = y;
        self.dc_y = dc;
        dc
    }
}

struct Tone {
    bass: Biquad,
    mid: Biquad,
    treble: Biquad,
    presence: Biquad,
    hpf: Biquad,
    bright: Biquad,
    key: [f64; 6],
    ready: bool,
}

impl Tone {
    fn new(sample_rate: f64) -> Self {
        Self {
            bass: design_biquad(BiquadKind::Lowshelf, sample_rate, 120.0, 0.7, 0.0),
            mid: design_biquad(BiquadKind::Peaking, sample_rate, 750.0, 0.8, 0.0),
            treble: design_biquad(BiquadKind::Highshelf, sample_rate, 3200.0, 0.7, 0.0),
            presence: design_biquad(BiquadKind::Highshelf, sample_rate, 5500.0, 0.7, 0.0),
            hpf: design_biquad(BiquadKind::Highpass, sample_rate, 80.0, 0.7, 0.0),
            bright: design_biquad(BiquadKind::Highshelf, sample_rate, 2200.0, 0.7, 0.0),
            key: [0.0; 6],
            ready: false,
        }
    }
    fn sync(&mut self, sample_rate: f64, model: usize, bass: f64, mid: f64, treble: f64, presence: f64, bright: f64) {
        let key = [model as f64, bass, mid, treble, presence, bright];
        if self.ready && key == self.key {
            return;
        }
        self.bass.copy_coeffs(&design_biquad(BiquadKind::Lowshelf, sample_rate, if model >= 6 { 80.0 } else { 140.0 }, 0.7, bass));
        self.mid.copy_coeffs(&design_biquad(BiquadKind::Peaking, sample_rate, if model >= 6 { 420.0 } else { 800.0 }, if model == 2 { 0.9 } else { 0.75 }, mid));
        self.treble.copy_coeffs(&design_biquad(BiquadKind::Highshelf, sample_rate, 2800.0, 0.7, treble));
        self.presence.copy_coeffs(&design_biquad(BiquadKind::Highshelf, sample_rate, if model == 5 { 4500.0 } else { 6200.0 }, 0.7, presence));
        self.hpf.copy_coeffs(&design_biquad(BiquadKind::Highpass, sample_rate, HPF[model], 0.707, 0.0));
        self.bright.copy_coeffs(&design_biquad(BiquadKind::Highshelf, sample_rate, 2400.0, 0.7, bright));
        self.key = key;
        self.ready = true;
    }
}

struct Fir {
    hist: Vec<f32>,
    pos: usize,
}

impl Fir {
    fn new(length: usize) -> Self {
        Self { hist: vec![0.0; length.max(1)], pos: 0 }
    }
    fn reset(&mut self) {
        self.hist.fill(0.0);
        self.pos = 0;
    }
    fn sample(&mut self, ir: &[f32], x: f64) -> f64 {
        let m = ir.len().min(self.hist.len());
        self.hist[self.pos] = x as f32;
        let mut y = 0.0;
        let mut k = self.pos;
        for i in 0..m {
            y += ir[i] as f64 * self.hist[k] as f64;
            k = if k == 0 { m - 1 } else { k - 1 };
        }
        self.pos += 1;
        if self.pos >= m {
            self.pos = 0;
        }
        y
    }
}

pub struct Amp {
    os: [Os; 2],
    tone: [Tone; 2],
    fir: [Fir; 2],
    ir: Vec<f32>,
    length: usize,
    key: [f64; 6],
    ready: bool,
    rate: f64,
}

impl Amp {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            os: [Os::new(sample_rate, 4), Os::new(sample_rate, 4)],
            tone: [Tone::new(sample_rate), Tone::new(sample_rate)],
            fir: [Fir::new(512), Fir::new(512)],
            ir: vec![0.0; 512],
            length: 0,
            key: [0.0; 6],
            ready: false,
            rate: sample_rate,
        }
    }

    pub fn reset(&mut self) {
        let rate = self.rate;
        self.os = [Os::new(rate, 4), Os::new(rate, 4)];
        self.tone = [Tone::new(rate), Tone::new(rate)];
        self.fir[0].reset();
        self.fir[1].reset();
        self.ir.fill(0.0);
        self.length = 0;
        self.ready = false;
    }

    pub fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        // The saturator catalog keeps the amp model at its default, Clear American.
        let model = 0usize;
        let gain = clamp(param(values, 13, 0.35), 0.0, 1.0);
        let factor = if eco { 2 } else { 4 };
        self.os[0].ensure(sample_rate, factor);
        self.os[1].ensure(sample_rate, factor);
        let bass = (clamp(param(values, 14, 0.5), 0.0, 1.0) - 0.5) * 24.0;
        let mid = (clamp(param(values, 15, 0.5), 0.0, 1.0) - 0.5) * 20.0;
        let treble = (clamp(param(values, 16, 0.5), 0.0, 1.0) - 0.5) * 18.0;
        let presence = (clamp(param(values, 17, 0.5), 0.0, 1.0) - 0.5) * 12.0;
        let bright = 0.0;
        self.tone[0].sync(sample_rate, 0, bass, mid, treble, presence, bright);
        self.tone[1].sync(sample_rate, 0, bass, mid, treble, presence, bright);
        let length = if eco { 256 } else { 512 };
        self.sync_ir(sample_rate, length);
        let cab_on = param(values, 19, 1.0) >= 0.001;
        let trim = clamp(param(values, 18, 0.65), 0.0, 1.0);
        let neutral = (param(values, 14, 0.5) - 0.5).abs() < 0.001
            && (param(values, 15, 0.5) - 0.5).abs() < 0.001
            && (param(values, 16, 0.5) - 0.5).abs() < 0.001
            && (param(values, 17, 0.5) - 0.5).abs() < 0.001;
        let amp_on = gain >= 0.001;
        for i in 0..frames {
            let mut l = left[i] as f64;
            let mut r = right[i] as f64;
            if amp_on {
                l = self.os[0].shape(tick(&mut self.tone[0].hpf, l), model, gain);
                r = self.os[1].shape(tick(&mut self.tone[1].hpf, r), model, gain);
                if !neutral {
                    l = tick(&mut self.tone[0].presence, tick(&mut self.tone[0].treble, tick(&mut self.tone[0].mid, tick(&mut self.tone[0].bass, l))));
                    r = tick(&mut self.tone[1].presence, tick(&mut self.tone[1].treble, tick(&mut self.tone[1].mid, tick(&mut self.tone[1].bass, r))));
                }
            }
            if cab_on {
                l = self.fir[0].sample(&self.ir[..self.length], l);
                r = self.fir[1].sample(&self.ir[..self.length], r);
            }
            l *= trim;
            r *= trim;
            let peak = l.abs().max(r.abs());
            if peak > 0.98 {
                let scale = 0.98 / peak;
                l *= scale;
                r *= scale;
            }
            left[i] = store(l);
            right[i] = store(r);
        }
    }

    fn sync_ir(&mut self, sample_rate: f64, length: usize) {
        // Defaults: cab A 0, mic 0, axis 0, distance 0. Blend is 0, so only cabinet A.
        let key = [0.0, 0.0, 0.0, 0.0, length as f64, sample_rate];
        if self.ready && key == self.key && self.length == length {
            return;
        }
        // Amp defaults: cab A 0, mic 0, axis 0, distance 0.2. Blend is 0, so cabinet B is silent.
        cabinet_ir(0, 0, 0.0, 0.2, length, sample_rate, &mut self.ir);
        self.length = length;
        self.fir[0].reset();
        self.fir[1].reset();
        self.key = key;
        self.ready = true;
    }
}

fn shape_sample(model: usize, x: f64, gain: f64) -> f64 {
    let drive = DRIVE[model];
    let y = x * (1.0 + gain * drive);
    if model == 5 {
        return y.tanh();
    }
    if model == 2 || model == 8 {
        return odd(odd(y) * (1.0 + gain * 0.8));
    }
    if model == 3 || model == 6 {
        let s = y.tanh();
        return s + 0.06 * s * s;
    }
    odd(y)
}

fn odd(y: f64) -> f64 {
    let s = y.tanh();
    s * (1.25 - 0.25 * s * s)
}

pub fn cabinet_ir_for_test(length: usize, sample_rate: f64, ir: &mut [f32]) {
    cabinet_ir(0, 0, 0.0, 0.0, length, sample_rate, ir);
}

fn cabinet_ir(cab: usize, mic: usize, axis: f64, distance: f64, length: usize, sample_rate: f64, ir: &mut [f32]) {
    for sample in ir.iter_mut().take(length) {
        *sample = 0.0;
    }
    let cab = cab.min(CAB_MODES.len() - 1);
    let axis = clamp(axis, 0.0, 1.0);
    let distance = clamp(distance, 0.0, 1.0);
    for mode in CAB_MODES[cab] {
        let (hz, decay, amp) = mode;
        let high = hz > 2000.0;
        let axis_gain = if high { 1.0 - axis * 0.72 } else { 1.0 - axis * 0.08 };
        let distance_gain = if high { 1.0 - distance * 0.55 } else { 1.0 };
        let mic_gain = if mic == 1 {
            if hz > 3000.0 { 1.35 } else { 1.0 }
        } else if mic == 2 {
            if hz > 2500.0 { 0.55 } else { 1.2 }
        } else {
            1.0
        };
        let level = amp * axis_gain * distance_gain * mic_gain;
        let decay = decay * (1.0 + distance * 0.25);
        for i in 0..length {
            let t = i as f64 / sample_rate;
            let mixed = ir[i] as f64 + level * (-t * decay).exp() * (2.0 * std::f64::consts::PI * hz * t).sin();
            ir[i] = mixed as f32;
        }
    }
    let mut seed = 1009i64 + cab as i64 * 17 + mic as i64 * 3;
    let air = length.min(360);
    for i in 0..air {
        seed = (seed * 16807) % 2147483647;
        let noise = (seed as f64 / 2147483647.0) * 2.0 - 1.0;
        let mixed = ir[i] as f64 + noise * 0.015 * (-(i as f64) / (36.0 + distance * 70.0)).exp() * (1.0 - axis * 0.45);
        ir[i] = mixed as f32;
    }
    let delay = js_round(distance * 12.0).max(0.0) as usize;
    if delay > 0 && delay < length {
        for i in (delay..length).rev() {
            ir[i] = ir[i - delay];
        }
        for i in 0..delay {
            ir[i] = 0.0;
        }
    }
    let mut peak = 0.0f32;
    for sample in ir.iter().take(length) {
        peak = peak.max(sample.abs());
    }
    if peak > 0.0 {
        let norm = 0.9 / peak;
        for sample in ir.iter_mut().take(length) {
            *sample *= norm;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cabinet_matches_the_published_first_taps() {
        let mut ir = vec![0.0; 512];
        cabinet_ir_for_test(512, 48_000.0, &mut ir);
        // Printed from the TypeScript cabinetIr for cab 0 at 48 kHz.
        assert!((ir[0] as f64 + 0.01068289764225483).abs() < 1e-5, "ir0 {}", ir[0]);
        assert!((ir[1] as f64 - 0.08872711658477783).abs() < 1e-5, "ir1 {}", ir[1]);
        assert!((ir[10] as f64 - 0.3076637387275696).abs() < 1e-4, "ir10 {}", ir[10]);
    }
}
