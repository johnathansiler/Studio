//! Reverb and delay inserts, including the kind switch.

use crate::biquad::{design_biquad, tick, Biquad, BiquadKind};
use crate::shaper::AnalogShaper;
use crate::smooth::SampleGlide;
use crate::util::{clamp, js_round, param, read_at, read_frac, read_int, write_stereo};

struct Comb {
    buf: Vec<f32>,
    index: usize,
    filter: f64,
    damp_state: f64,
}

impl Comb {
    fn new(length: usize) -> Self {
        Self { buf: vec![0.0; length.max(2)], index: 0, filter: 0.0, damp_state: 0.0 }
    }
    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.index = 0;
        self.filter = 0.0;
        self.damp_state = 0.0;
    }
    fn freeverb(&mut self, sample: f64, feedback: f64, damp: f64) -> f64 {
        let delayed = self.buf[self.index] as f64;
        self.filter = delayed * (1.0 - damp) + self.filter * damp;
        self.buf[self.index] = crate::util::store(sample + self.filter * feedback);
        self.index = (self.index + 1) % self.buf.len();
        delayed
    }
    fn plate(&mut self, sample: f64, feedback: f64, damp: f64) -> f64 {
        let delayed = self.buf[self.index] as f64;
        self.damp_state = delayed * (1.0 - damp) + self.damp_state * damp;
        self.buf[self.index] = (sample + self.damp_state * feedback) as f32;
        self.index = (self.index + 1) % self.buf.len();
        delayed
    }
}

struct Verb {
    combs: Vec<Comb>,
    mix: SampleGlide,
}

impl Verb {
    fn new(sample_rate: f64, scales: &[f64]) -> Self {
        Self {
            combs: scales.iter().map(|scale| Comb::new((sample_rate * scale).round().max(2.0) as usize)).collect(),
            mix: SampleGlide::default(),
        }
    }
    fn reset(&mut self) {
        for comb in &mut self.combs {
            comb.clear();
        }
        self.mix.reset();
    }
    fn process(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, size: f64, decay: f64, damp: f64, mix: f64, sample_rate: f64, eco: bool) {
        let size = clamp(size, 0.15, 1.0);
        let decay = clamp(decay, 0.05, 0.98);
        let damp = clamp(damp, 0.0, 0.95);
        let mix_target = clamp(mix, 0.0, 1.0);
        self.mix.prepare(sample_rate);
        let feedback = decay * (0.55 + size * 0.4);
        let used = if eco { (self.combs.len() - 2).max(2) } else { self.combs.len() };
        for i in 0..frames {
            let amount = self.mix.next(mix_target);
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let mut wet_l = 0.0;
            let mut wet_r = 0.0;
            for c in 0..used {
                let tap = self.combs[c].plate(if c % 2 == 0 { dry_l } else { dry_r } * 0.2, feedback, damp);
                if c % 2 == 0 {
                    wet_l += tap;
                } else {
                    wet_r += tap;
                }
            }
            write_stereo(left, right, i, dry_l * (1.0 - amount) + (wet_l / 2.0) * amount, dry_r * (1.0 - amount) + (wet_r / 2.0) * amount);
        }
    }
}

pub struct SpaceBank {
    rate: f64,
    algo: Vec<Comb>,
    allpass: Vec<Comb>,
    algo_mix: SampleGlide,
    plate: Verb,
    halls: [Verb; 3],
    hall_mode: i32,
    ir: [Vec<f32>; 2],
    history: [Vec<f32>; 2],
    conv_write: usize,
    delay_l: Vec<f32>,
    delay_r: Vec<f32>,
    delay_write: usize,
    delay_filter: Biquad,
    delay_freq: f64,
    delay_mix: SampleGlide,
    echo_l: Vec<f32>,
    echo_r: Vec<f32>,
    echo_write: usize,
    echo_phase: f64,
    echo_shaper: AnalogShaper,
    bbd_l: Vec<f32>,
    bbd_r: Vec<f32>,
    bbd_write: usize,
    bbd_tone: [Biquad; 2],
    digital_l: Vec<f32>,
    digital_r: Vec<f32>,
    digital_write: usize,
}

impl SpaceBank {
    pub fn new(sample_rate: f64) -> Self {
        let algo = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116]
            .map(|length| Comb::new(((length as f64) * sample_rate / 44100.0).round().max(8.0) as usize));
        let allpass = [113, 83, 53, 37].map(|prime| Comb::new(((prime as f64) * sample_rate / 48000.0).round().max(8.0) as usize));
        let rooms: [&[f64]; 3] = [
            &[0.018, 0.023, 0.029, 0.037],
            &[0.031, 0.043, 0.057, 0.071, 0.083, 0.097],
            &[0.024, 0.03, 0.038, 0.046, 0.055],
        ];
        Self {
            rate: sample_rate,
            algo: algo.into_iter().collect(),
            allpass: allpass.into_iter().collect(),
            algo_mix: SampleGlide::default(),
            plate: Verb::new(sample_rate, &[0.021, 0.027, 0.033, 0.039, 0.044, 0.051]),
            halls: [
                Verb::new(sample_rate, rooms[0]),
                Verb::new(sample_rate, rooms[1]),
                Verb::new(sample_rate, rooms[2]),
            ],
            hall_mode: 1,
            ir: [original_ir(0, 4096), original_ir(1, 4096)],
            history: [vec![0.0; 4096], vec![0.0; 4096]],
            conv_write: 0,
            delay_l: vec![0.0; (sample_rate * 2.0).ceil().max(8.0) as usize],
            delay_r: vec![0.0; (sample_rate * 2.0).ceil().max(8.0) as usize],
            delay_write: 0,
            delay_filter: design_biquad(BiquadKind::Lowpass, sample_rate, 5000.0, 0.7, 0.0),
            delay_freq: 5000.0,
            delay_mix: SampleGlide::default(),
            echo_l: line(1.2, sample_rate),
            echo_r: line(1.2, sample_rate),
            echo_write: 0,
            echo_phase: 0.0,
            echo_shaper: AnalogShaper::new(2),
            bbd_l: line(0.4, sample_rate),
            bbd_r: line(0.4, sample_rate),
            bbd_write: 0,
            bbd_tone: [
                design_biquad(BiquadKind::Lowpass, sample_rate, 3000.0, 0.7, 0.0),
                design_biquad(BiquadKind::Lowpass, sample_rate, 3000.0, 0.7, 0.0),
            ],
            digital_l: line(2.0, sample_rate),
            digital_r: line(2.0, sample_rate),
            digital_write: 0,
        }
    }

    pub fn reset(&mut self) {
        for comb in &mut self.algo {
            comb.clear();
        }
        for comb in &mut self.allpass {
            comb.clear();
        }
        self.algo_mix.reset();
        self.plate.reset();
        for hall in &mut self.halls {
            hall.reset();
        }
        self.history[0].fill(0.0);
        self.history[1].fill(0.0);
        self.conv_write = 0;
        self.delay_l.fill(0.0);
        self.delay_r.fill(0.0);
        self.delay_write = 0;
        self.delay_filter.clear_state();
        self.delay_mix.reset();
        self.echo_l.fill(0.0);
        self.echo_r.fill(0.0);
        self.echo_write = 0;
        self.echo_phase = 0.0;
        self.echo_shaper = AnalogShaper::new(2);
        self.bbd_l.fill(0.0);
        self.bbd_r.fill(0.0);
        self.bbd_write = 0;
        self.bbd_tone[0].clear_state();
        self.bbd_tone[1].clear_state();
        self.digital_l.fill(0.0);
        self.digital_r.fill(0.0);
        self.digital_write = 0;
    }

    pub fn process_reverb(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let kind = js_round(param(values, 0, 0.0)).clamp(0.0, 3.0) as i32;
        match kind {
            1 => self.plate.process(left, right, frames, param(values, 2, 0.6), param(values, 3, 0.72), param(values, 4, 0.4), param(values, 5, 0.25), sample_rate, eco),
            2 => {
                let mode = js_round(param(values, 1, 1.0)).clamp(0.0, 2.0) as i32;
                self.hall_mode = mode;
                let decays = [0.62, 0.86, 0.62];
                let decay = param(values, 3, decays[mode as usize]);
                self.halls[mode as usize].process(left, right, frames, param(values, 2, 0.6), decay, param(values, 4, 0.4), param(values, 5, 0.25), sample_rate, eco);
            }
            3 => self.conv(left, right, frames, values, eco),
            _ => self.algorithm(left, right, frames, values, sample_rate, eco),
        }
    }

    pub fn process_delay(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, tempo: f64) {
        let kind = js_round(param(values, 0, 0.0)).clamp(0.0, 3.0) as i32;
        match kind {
            1 => self.echo(left, right, frames, values, sample_rate),
            2 => self.bbd(left, right, frames, values, sample_rate),
            3 => self.digital(left, right, frames, values, sample_rate),
            _ => self.studio(left, right, frames, values, sample_rate, tempo),
        }
    }

    fn algorithm(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, eco: bool) {
        let mix_target = clamp(param(values, 5, 0.0), 0.0, 1.0);
        self.algo_mix.prepare(sample_rate);
        let size = clamp(param(values, 2, 0.6), 0.05, 1.0);
        let damp = clamp(param(values, 4, 0.4), 0.0, 0.95);
        let mode = js_round(clamp(param(values, 1, 2.0), 0.0, 2.0)) as i32;
        let feedback = (if mode == 0 { 0.55 } else if mode == 1 { 0.62 } else { 0.78 }) * (0.45 + size * 0.55);
        let used = if eco { 4 } else { self.algo.len() };
        for i in 0..frames {
            let mix = self.algo_mix.next(mix_target);
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let mono = (dry_l + dry_r) * 0.5;
            let mut wet = 0.0;
            for c in 0..used {
                wet += self.algo[c].freeverb(mono, feedback, damp);
            }
            wet /= used as f64;
            let mut splashed = wet;
            for pass in &mut self.allpass {
                let delayed = pass.buf[pass.index] as f64;
                pass.buf[pass.index] = crate::util::store(splashed + delayed * 0.5);
                splashed = delayed - splashed * 0.5;
                pass.index = (pass.index + 1) % pass.buf.len();
            }
            let side = if mode == 0 { 0.2 } else { 0.45 };
            write_stereo(
                left,
                right,
                i,
                dry_l * (1.0 - mix) + (splashed * (1.0 - side) + wet * side) * mix,
                dry_r * (1.0 - mix) + (splashed * (1.0 + side) * 0.5 + wet * 0.2) * mix,
            );
        }
    }

    fn conv(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], eco: bool) {
        let kind = js_round(param(values, 6, 0.0)).clamp(0.0, 1.0) as usize;
        let length = if eco { 512 } else { 2048 };
        let step = if eco { 2 } else { 1 };
        let amount = clamp(param(values, 5, 0.3), 0.0, 1.0);
        let ir = &self.ir[kind];
        for i in 0..frames {
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.history[0][self.conv_write] = dry_l as f32;
            self.history[1][self.conv_write] = dry_r as f32;
            let mut wet_l = 0.0;
            let mut wet_r = 0.0;
            let mut tap = 0;
            while tap < length {
                let index = (self.conv_write + self.history[0].len() - tap) % self.history[0].len();
                wet_l += self.history[0][index] as f64 * ir[tap] as f64;
                wet_r += self.history[1][index] as f64 * ir[tap] as f64;
                tap += step;
            }
            write_stereo(left, right, i, dry_l * (1.0 - amount) + wet_l * amount, dry_r * (1.0 - amount) + wet_r * amount);
            self.conv_write = (self.conv_write + 1) % self.history[0].len();
        }
    }

    fn studio(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64, tempo: f64) {
        let freq = param(values, 6, 5000.0);
        if freq != self.delay_freq {
            let next = design_biquad(BiquadKind::Lowpass, sample_rate, freq, 0.7, 0.0);
            self.delay_filter.copy_coeffs(&next);
            self.delay_freq = freq;
        }
        let mix_target = clamp(param(values, 7, 0.0), 0.0, 1.0);
        self.delay_mix.prepare(sample_rate);
        let feedback = clamp(param(values, 4, 0.35), 0.0, 0.9);
        let samples = if param(values, 1, 1.0) >= 0.5 {
            ((60.0 / tempo.max(1.0)) * param(values, 2, 0.375) * sample_rate).max(1.0)
        } else {
            ((param(values, 3, 250.0) / 1000.0) * sample_rate).max(1.0)
        };
        let ping = param(values, 5, 1.0) >= 0.5;
        let length = self.delay_l.len();
        for i in 0..frames {
            let mix = self.delay_mix.next(mix_target);
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let tap_l = read_at(&self.delay_l, self.delay_write, samples);
            let tap_r = read_at(&self.delay_r, self.delay_write, if ping { samples * 0.5 } else { samples });
            let fb = tick(&mut self.delay_filter, (tap_l + tap_r) * 0.5) * feedback;
            self.delay_l[self.delay_write] = crate::util::store(dry_l + fb);
            self.delay_r[self.delay_write] = crate::util::store(dry_r + fb);
            self.delay_write = (self.delay_write + 1) % length;
            let wet_r = if ping { tap_r } else { tap_l };
            write_stereo(left, right, i, dry_l * (1.0 - mix) + tap_l * mix, dry_r * (1.0 - mix) + wet_r * mix);
        }
    }

    fn echo(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let time = clamp(param(values, 3, 280.0), 20.0, 1000.0) / 1000.0;
        let feedback = clamp(param(values, 4, 0.35), 0.0, 0.9);
        let wow = clamp(param(values, 8, 0.25), 0.0, 1.0);
        let drive = clamp(param(values, 9, 0.3), 0.0, 1.0);
        let amount = clamp(param(values, 7, 0.3), 0.0, 1.0);
        let base = time * sample_rate;
        let length = self.echo_l.len();
        for i in 0..frames {
            self.echo_phase += (2.0 * std::f64::consts::PI * 0.7) / sample_rate;
            let read = self.echo_write as f64 - base - self.echo_phase.sin() * wow * 12.0;
            let echo_l = read_frac(&self.echo_l, read);
            let echo_r = read_frac(&self.echo_r, read);
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            let bent = self.echo_shaper.oversample((echo_l + echo_r) * 0.5, drive);
            self.echo_l[self.echo_write] = (dry_l + bent * feedback) as f32;
            self.echo_r[self.echo_write] = (dry_r + bent * feedback) as f32;
            write_stereo(left, right, i, dry_l * (1.0 - amount) + echo_l * amount, dry_r * (1.0 - amount) + echo_r * amount);
            self.echo_write = (self.echo_write + 1) % length;
        }
    }

    fn bbd(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let time = clamp(param(values, 3, 180.0), 10.0, 380.0) / 1000.0;
        let feedback = clamp(param(values, 4, 0.3), 0.0, 0.85);
        let clock = clamp(param(values, 10, 0.5), 0.0, 1.0);
        let cutoff = 1200.0 + (1.0 - clock) * 5000.0;
        let amount = clamp(param(values, 7, 0.3), 0.0, 1.0);
        let mut filter = [
            design_biquad(BiquadKind::Lowpass, sample_rate, cutoff, 0.7, 0.0),
            design_biquad(BiquadKind::Lowpass, sample_rate, cutoff, 0.7, 0.0),
        ];
        filter[0].x1 = self.bbd_tone[0].x1;
        filter[0].x2 = self.bbd_tone[0].x2;
        filter[0].y1 = self.bbd_tone[0].y1;
        filter[0].y2 = self.bbd_tone[0].y2;
        filter[1].x1 = self.bbd_tone[1].x1;
        filter[1].x2 = self.bbd_tone[1].x2;
        filter[1].y1 = self.bbd_tone[1].y1;
        filter[1].y2 = self.bbd_tone[1].y2;
        let delay_samples = time * sample_rate;
        let length = self.bbd_l.len();
        for i in 0..frames {
            let echo_l = tick(&mut filter[0], read_frac(&self.bbd_l, self.bbd_write as f64 - delay_samples));
            let echo_r = tick(&mut filter[1], read_frac(&self.bbd_r, self.bbd_write as f64 - delay_samples));
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.bbd_l[self.bbd_write] = (dry_l + echo_l * feedback) as f32;
            self.bbd_r[self.bbd_write] = (dry_r + echo_r * feedback) as f32;
            write_stereo(left, right, i, dry_l * (1.0 - amount) + echo_l * amount, dry_r * (1.0 - amount) + echo_r * amount);
            self.bbd_write = (self.bbd_write + 1) % length;
        }
        self.bbd_tone[0].x1 = filter[0].x1;
        self.bbd_tone[0].x2 = filter[0].x2;
        self.bbd_tone[0].y1 = filter[0].y1;
        self.bbd_tone[0].y2 = filter[0].y2;
        self.bbd_tone[1].x1 = filter[1].x1;
        self.bbd_tone[1].x2 = filter[1].x2;
        self.bbd_tone[1].y1 = filter[1].y1;
        self.bbd_tone[1].y2 = filter[1].y2;
    }

    fn digital(&mut self, left: &mut [f32], right: &mut [f32], frames: usize, values: &[f64], sample_rate: f64) {
        let time = clamp(param(values, 3, 250.0), 1.0, 1800.0) / 1000.0;
        let feedback = clamp(param(values, 4, 0.3), 0.0, 0.95);
        let amount = clamp(param(values, 7, 0.3), 0.0, 1.0);
        let delay_samples = js_round(time * sample_rate);
        let length = self.digital_l.len();
        for i in 0..frames {
            let echo_l = read_int(&self.digital_l, self.digital_write as f64 - delay_samples);
            let echo_r = read_int(&self.digital_r, self.digital_write as f64 - delay_samples);
            let dry_l = left[i] as f64;
            let dry_r = right[i] as f64;
            self.digital_l[self.digital_write] = (dry_l + echo_l * feedback) as f32;
            self.digital_r[self.digital_write] = (dry_r + echo_r * feedback) as f32;
            write_stereo(left, right, i, dry_l * (1.0 - amount) + echo_l * amount, dry_r * (1.0 - amount) + echo_r * amount);
            self.digital_write = (self.digital_write + 1) % length;
        }
    }
}

fn line(seconds: f64, sample_rate: f64) -> Vec<f32> {
    vec![0.0; (seconds * sample_rate).round().max(8.0) as usize]
}

fn original_ir(kind: i32, length: usize) -> Vec<f32> {
    let mut ir = vec![0.0; length];
    let mut seed = if kind == 0 { 29i64 } else { 73 };
    for i in 0..length {
        seed = (seed * 16807) % 2147483647;
        let noise = (seed as f64 / 2147483647.0) * 2.0 - 1.0;
        let t = i as f64 / length as f64;
        let body = if kind == 0 { (-t * 8.0).exp() } else { (-t * 3.2).exp() };
        let tone = if kind == 0 { 1.0 } else { 0.65 + 0.35 * (t * 48.0).sin() };
        ir[i] = (noise * body * tone * 0.15) as f32;
    }
    ir[0] = 0.4;
    ir
}
