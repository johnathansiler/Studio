//! Oversampled shapers from `models/analog.ts` and `quality/oversample.ts`.
//! Kernels are built in `prepare`, not in `process_block`.

const ANALOG_TAPS: usize = 16;
const ANALOG_DOWN: usize = 63;
const SOFT_TAPS: usize = 12;
const SOFT_DOWN: usize = 48;
const SOFT_FACTOR: usize = 4;

fn analog_kernel(length: usize, cutoff: f64, gain: f64, out: &mut [f64]) {
    // Same Kaiser lowpass as `soft_lowpass`. Cutoff scales the sinc, not only the height.
    soft_lowpass(length, cutoff, gain, out);
}

fn polyphase(factor: usize, cutoff: f64, gain: f64, branch: &mut [f64]) {
    let full_len = factor * ANALOG_TAPS;
    let mut full = [0.0; 4 * ANALOG_TAPS];
    analog_kernel(full_len, cutoff, gain, &mut full);
    for phase in 0..factor {
        for tap in 0..ANALOG_TAPS {
            branch[phase * ANALOG_TAPS + tap] = full[tap * factor + phase];
        }
    }
}

#[derive(Clone)]
pub struct AnalogShaper {
    pub factor: usize,
    hist: [f64; ANALOG_TAPS],
    high: [f64; ANALOG_DOWN],
    write: usize,
    high_write: usize,
    prev_u: f64,
    prev_f: f64,
    phases: [f64; 4 * ANALOG_TAPS],
    down: [f64; ANALOG_DOWN],
}

impl AnalogShaper {
    pub fn new(factor: usize) -> Self {
        let mut shaper = Self {
            factor: 4,
            hist: [0.0; ANALOG_TAPS],
            high: [0.0; ANALOG_DOWN],
            write: 0,
            high_write: 0,
            prev_u: 0.0,
            prev_f: 0.0,
            phases: [0.0; 4 * ANALOG_TAPS],
            down: [0.0; ANALOG_DOWN],
        };
        shaper.set_factor(factor);
        shaper
    }

    pub fn set_factor(&mut self, factor: usize) {
        let rate = if factor <= 2 { 2 } else { 4 };
        if self.factor == rate && self.phases[0] != 0.0 {
            return;
        }
        self.factor = rate;
        self.hist = [0.0; ANALOG_TAPS];
        self.high = [0.0; ANALOG_DOWN];
        self.write = 0;
        self.high_write = 0;
        self.prev_u = 0.0;
        self.prev_f = 0.0;
        polyphase(rate, 0.45 / rate as f64, rate as f64, &mut self.phases);
        analog_kernel(ANALOG_DOWN, 0.4 / rate as f64, 1.0, &mut self.down);
    }

    pub fn force_factor(&mut self, factor: usize) {
        let rate = if factor <= 2 { 2 } else { 4 };
        self.factor = 0;
        self.set_factor(rate);
    }

    pub fn oversample(&mut self, sample: f64, drive: f64) -> f64 {
        if drive <= 0.0001 {
            return sample;
        }
        self.hist[self.write] = sample;
        let factor = self.factor;
        for phase in 0..factor {
            let branch = &self.phases[phase * ANALOG_TAPS..phase * ANALOG_TAPS + ANALOG_TAPS];
            let mut acc = 0.0;
            for tap in 0..ANALOG_TAPS {
                let index = (self.write + ANALOG_TAPS - tap) % ANALOG_TAPS;
                acc += self.hist[index] * branch[tap];
            }
            self.high[self.high_write] = color_sample(acc, drive, &mut self.prev_u, &mut self.prev_f);
            self.high_write = (self.high_write + 1) % ANALOG_DOWN;
        }
        self.write = (self.write + 1) % ANALOG_TAPS;
        let mut mixed = 0.0;
        for tap in 0..ANALOG_DOWN {
            let index = (self.high_write + ANALOG_DOWN - 1 - tap) % ANALOG_DOWN;
            mixed += self.high[index] * self.down[tap];
        }
        mixed
    }
}

fn color_sample(x: f64, drive: f64, prev_u: &mut f64, prev_f: &mut f64) -> f64 {
    let amount = crate::util::clamp(drive, 0.0, 1.0);
    let shaped = x * (1.0 + amount * 3.0);
    let limited = shaped.clamp(-12.0, 12.0);
    let next = limited.cosh().ln();
    let delta = limited - *prev_u;
    let tanh_adaa = if delta.abs() < 1e-5 {
        limited.tanh()
    } else {
        (next - *prev_f) / delta
    };
    *prev_u = limited;
    *prev_f = next;
    let sign = if limited > 0.0 {
        1.0
    } else if limited < 0.0 {
        -1.0
    } else {
        0.0
    };
    let even = amount * 0.15 * limited * limited * sign / (1.0 + limited * limited);
    (tanh_adaa + even) / (1.0 + amount * 0.6)
}

fn kaiser_bessel(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x * 0.5;
    for k in 1..=10 {
        term *= (half * half) / ((k * k) as f64);
        sum += term;
    }
    sum
}

fn kaiser(amount: f64, beta: f64) -> f64 {
    let inside = 1.0 - amount * amount;
    if inside > 0.0 {
        kaiser_bessel(beta * inside.sqrt()) / kaiser_bessel(beta)
    } else {
        0.0
    }
}

fn soft_lowpass(length: usize, cutoff: f64, gain: f64, out: &mut [f64]) {
    let mid = (length as f64 - 1.0) / 2.0;
    let beta = 8.0;
    let mut sum = 0.0;
    for i in 0..length {
        let x = i as f64 - mid;
        let arg = 2.0 * cutoff * x;
        let sinc = if arg.abs() < 1e-8 {
            1.0
        } else {
            let p = std::f64::consts::PI * arg;
            p.sin() / p
        };
        let amount = if mid == 0.0 { 0.0 } else { x / mid };
        out[i] = 2.0 * cutoff * sinc * kaiser(amount, beta);
        sum += out[i];
    }
    let scale = if sum != 0.0 { gain / sum } else { 1.0 };
    for tap in out.iter_mut().take(length) {
        *tap *= scale;
    }
}

#[derive(Clone)]
pub struct SoftShaper {
    ring: [f64; SOFT_TAPS],
    write: usize,
    high: [f64; SOFT_DOWN],
    high_write: usize,
    prev_u: f64,
    prev_f: f64,
    phases: [f64; SOFT_FACTOR * SOFT_TAPS],
    down: [f64; SOFT_DOWN],
    ready: bool,
}

impl SoftShaper {
    pub fn new() -> Self {
        let mut shaper = Self {
            ring: [0.0; SOFT_TAPS],
            write: 0,
            high: [0.0; SOFT_DOWN],
            high_write: 0,
            prev_u: 0.0,
            prev_f: 0.0,
            phases: [0.0; SOFT_FACTOR * SOFT_TAPS],
            down: [0.0; SOFT_DOWN],
            ready: false,
        };
        shaper.prepare();
        shaper
    }

    pub fn prepare(&mut self) {
        if self.ready {
            return;
        }
        let full_len = SOFT_FACTOR * SOFT_TAPS;
        let mut kernel = [0.0; SOFT_FACTOR * SOFT_TAPS];
        soft_lowpass(full_len, 0.45 / SOFT_FACTOR as f64, SOFT_FACTOR as f64, &mut kernel);
        for phase in 0..SOFT_FACTOR {
            for tap in 0..SOFT_TAPS {
                self.phases[phase * SOFT_TAPS + tap] = kernel[tap * SOFT_FACTOR + phase];
            }
        }
        soft_lowpass(SOFT_DOWN, 0.4 / SOFT_FACTOR as f64, 1.0, &mut self.down);
        self.ready = true;
    }

    pub fn reset(&mut self) {
        self.ring = [0.0; SOFT_TAPS];
        self.high = [0.0; SOFT_DOWN];
        self.write = 0;
        self.high_write = 0;
        self.prev_u = 0.0;
        self.prev_f = 0.0;
    }

    pub fn shape(&mut self, sample: f64, drive: f64, shape: f64) -> f64 {
        self.ring[self.write] = sample;
        let norm = shape.tanh();
        let norm = if norm == 0.0 { 1.0 } else { norm };
        for phase in 0..SOFT_FACTOR {
            let taps = &self.phases[phase * SOFT_TAPS..phase * SOFT_TAPS + SOFT_TAPS];
            let mut acc = 0.0;
            for tap in 0..SOFT_TAPS {
                let index = (self.write + SOFT_TAPS - tap) % SOFT_TAPS;
                acc += self.ring[index] * taps[tap];
            }
            let curved = (acc + drive * acc * acc * 0.2) * shape;
            self.high[self.high_write] = adaa_tanh(curved, &mut self.prev_u, &mut self.prev_f) / norm;
            self.high_write = (self.high_write + 1) % SOFT_DOWN;
        }
        self.write = (self.write + 1) % SOFT_TAPS;
        let mut mixed = 0.0;
        for tap in 0..SOFT_DOWN {
            let index = (self.high_write + SOFT_DOWN - 1 - tap) % SOFT_DOWN;
            mixed += self.high[index] * self.down[tap];
        }
        mixed
    }
}

impl Default for SoftShaper {
    fn default() -> Self {
        Self::new()
    }
}

fn adaa_tanh(u: f64, prev_u: &mut f64, prev_f: &mut f64) -> f64 {
    let limited = u.clamp(-20.0, 20.0);
    let next = limited.cosh().ln();
    let delta = limited - *prev_u;
    let y = if delta.abs() < 1e-6 {
        limited.tanh()
    } else {
        (next - *prev_f) / delta
    };
    *prev_u = limited;
    *prev_f = next;
    y
}

pub fn shaper_latency_samples() -> u32 {
    crate::util::js_round((SOFT_TAPS as f64 + SOFT_DOWN as f64 / SOFT_FACTOR as f64) / 2.0) as u32
}
