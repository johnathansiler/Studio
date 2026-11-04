//! Windowed-sinc oversampling from `src/audio/master/fir.ts`.
//! State is reserved in `prepare`. `process` does not allocate.

fn sinc_kernel(taps: usize, cutoff: f64, gain: f64, kernel: &mut [f32]) {
    let mid = (taps as f64 - 1.0) / 2.0;
    let mut sum = 0.0;
    for n in 0..taps {
        let x = n as f64 - mid;
        let sinc = if x == 0.0 {
            2.0 * cutoff
        } else {
            (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
        };
        let window = 0.5 - 0.5 * ((2.0 * std::f64::consts::PI * n as f64) / (taps as f64 - 1.0).max(1.0)).cos();
        let weight = sinc * window;
        kernel[n] = weight as f32;
        sum += weight;
    }
    let scale = if sum == 0.0 { 1.0 } else { gain / sum };
    for tap in kernel.iter_mut().take(taps) {
        *tap = (*tap as f64 * scale) as f32;
    }
}

#[derive(Clone)]
pub struct Upsampler {
    factor: usize,
    taps: usize,
    kernel: Vec<f32>,
    state: Vec<f32>,
}

impl Upsampler {
    pub fn new(factor: usize, taps: usize) -> Self {
        let mut kernel = vec![0.0; taps];
        sinc_kernel(taps, 0.5 / factor as f64, factor as f64, &mut kernel);
        Self {
            factor,
            taps,
            kernel,
            state: vec![0.0; taps],
        }
    }

    pub fn reset(&mut self) {
        self.state.fill(0.0);
    }

    pub fn factor(&self) -> usize {
        self.factor
    }

    pub fn latency(&self) -> f64 {
        let group = ((self.taps as i32 - 1) / 2) as f64;
        (group / self.factor as f64).floor() * 2.0
    }

    /// Write `frames * factor` high-rate samples. `shape` is the nonlinearity.
    pub fn upsample_into(&mut self, input: &[f32], frames: usize, out: &mut [f32], shape: impl Fn(f64) -> f64) {
        let mut produced = 0;
        for i in 0..frames {
            for phase in 0..self.factor {
                self.state.copy_within(1..self.taps, 0);
                self.state[self.taps - 1] = if phase == 0 { input.get(i).copied().unwrap_or(0.0) } else { 0.0 };
                let mut acc = 0.0;
                for k in 0..self.taps {
                    acc += self.state[k] as f64 * self.kernel[k] as f64;
                }
                if produced < out.len() {
                    out[produced] = shape(acc) as f32;
                    produced += 1;
                }
            }
        }
    }
}

#[derive(Clone)]
pub struct Downsampler {
    factor: usize,
    taps: usize,
    kernel: Vec<f32>,
    state: Vec<f32>,
    hold: usize,
}

impl Downsampler {
    pub fn new(factor: usize, taps: usize) -> Self {
        let mut kernel = vec![0.0; taps];
        sinc_kernel(taps, 0.5 / factor as f64, 1.0, &mut kernel);
        Self {
            factor,
            taps,
            kernel,
            state: vec![0.0; taps],
            hold: 0,
        }
    }

    pub fn reset(&mut self) {
        self.state.fill(0.0);
        self.hold = 0;
    }

    pub fn latency(&self) -> f64 {
        (((self.taps as i32 - 1) / 2) as f64 / self.factor as f64).floor()
    }

    pub fn process(&mut self, input: &[f32], output: &mut [f32]) {
        let mut produced = 0;
        for sample in input {
            if produced >= output.len() {
                break;
            }
            self.state.copy_within(1..self.taps, 0);
            self.state[self.taps - 1] = *sample;
            self.hold += 1;
            if self.hold < self.factor {
                continue;
            }
            self.hold = 0;
            let mut acc = 0.0;
            for k in 0..self.taps {
                acc += self.state[k] as f64 * self.kernel[k] as f64;
            }
            output[produced] = acc as f32;
            produced += 1;
        }
    }
}

/// Combined up, shape, down. Matches `createOversample` when the shaped samples
/// are written back at the original rate.
#[derive(Clone)]
pub struct Oversampler {
    up: Upsampler,
    down_kernel: Vec<f32>,
    down_state: Vec<f32>,
    factor: usize,
    taps: usize,
}

impl Oversampler {
    pub fn new(factor: usize, taps: usize) -> Self {
        let mut down_kernel = vec![0.0; taps];
        sinc_kernel(taps, 0.5 / factor as f64, 1.0, &mut down_kernel);
        Self {
            up: Upsampler::new(factor, taps),
            down_kernel,
            down_state: vec![0.0; taps],
            factor,
            taps,
        }
    }

    pub fn reset(&mut self) {
        self.up.reset();
        self.down_state.fill(0.0);
    }

    pub fn latency(&self) -> f64 {
        self.up.latency()
    }

    pub fn process(&mut self, input: &[f32], output: &mut [f32], shape: impl Fn(f64) -> f64) {
        let frames = input.len().min(output.len());
        let mut produced = 0;
        let mut hold = 0;
        for i in 0..frames {
            for phase in 0..self.factor {
                self.up.state.copy_within(1..self.taps, 0);
                self.up.state[self.taps - 1] = if phase == 0 { input[i] } else { 0.0 };
                let mut acc = 0.0;
                for k in 0..self.taps {
                    acc += self.up.state[k] as f64 * self.up.kernel[k] as f64;
                }
                let shaped = shape(acc) as f32;
                self.down_state.copy_within(1..self.taps, 0);
                self.down_state[self.taps - 1] = shaped;
                hold += 1;
                if hold < self.factor {
                    continue;
                }
                let mut mixed = 0.0;
                for k in 0..self.taps {
                    mixed += self.down_state[k] as f64 * self.down_kernel[k] as f64;
                }
                if produced < frames {
                    output[produced] = mixed as f32;
                }
                produced += 1;
                hold = 0;
            }
        }
        for sample in output.iter_mut().take(frames).skip(produced) {
            *sample = 0.0;
        }
    }
}
