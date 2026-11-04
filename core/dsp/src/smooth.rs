//! Same 5–15 ms exponential approach as `glideValue` and `ParamSmoother` in
//! `src/audio/paramCurve.ts` and `src/audio/core/smooth.ts`.

/// Matches `PARAM_SMOOTH_SEC`.
pub const PARAM_SMOOTH_SEC: f64 = 0.01;

const MAX_LANES: usize = 64;

pub struct ParamSmoother {
    current: [f64; MAX_LANES],
    target: [f64; MAX_LANES],
    count: usize,
    rate: f64,
}

impl Default for ParamSmoother {
    fn default() -> Self {
        Self {
            current: [0.0; MAX_LANES],
            target: [0.0; MAX_LANES],
            count: 0,
            rate: 48_000.0,
        }
    }
}

impl ParamSmoother {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fixed lane table. No heap. Call again if the sample rate changes.
    pub fn prepare(&mut self, count: usize, sample_rate: f64) {
        self.count = count.min(MAX_LANES);
        self.rate = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
    }

    pub fn snap(&mut self, index: usize, value: f64) {
        if index >= self.count {
            return;
        }
        let next = if value.is_finite() { value } else { 0.0 };
        self.target[index] = next;
        self.current[index] = next;
    }

    pub fn set_target(&mut self, index: usize, value: f64) {
        if index >= self.count {
            return;
        }
        self.target[index] = if value.is_finite() { value } else { 0.0 };
    }

    pub fn target(&self, index: usize) -> f64 {
        if index >= self.count {
            0.0
        } else {
            self.target[index]
        }
    }

    pub fn current(&self, index: usize) -> f64 {
        if index >= self.count {
            0.0
        } else {
            self.current[index]
        }
    }

    pub fn next_sample(&mut self, index: usize) -> f64 {
        if index >= self.count {
            return 0.0;
        }
        let next = glide_sample(self.current[index], self.target[index], self.rate);
        self.current[index] = next;
        next
    }

    pub fn next_block(&mut self, index: usize, frames: usize) -> f64 {
        if index >= self.count {
            return 0.0;
        }
        let next = glide_block(self.current[index], self.target[index], frames, self.rate);
        self.current[index] = next;
        next
    }
}

pub fn sample_alpha(sample_rate: f64) -> f64 {
    let tau = PARAM_SMOOTH_SEC.clamp(0.005, 0.015);
    let rate = if sample_rate > 0.0 {
        sample_rate
    } else {
        48_000.0
    };
    1.0 - (-1.0 / (tau * rate)).exp()
}

/// One sample of the approach. Matches `ParamSmoother.nextSample`.
pub fn glide_sample(from: f64, to: f64, sample_rate: f64) -> f64 {
    let start = if from.is_finite() { from } else { to };
    let target = if to.is_finite() { to } else { start };
    if (start - target).abs() < 1e-6 {
        return target;
    }
    start + (target - start) * sample_alpha(sample_rate)
}

/// One block step. Matches `glideValue` with the default 10 ms time.
/// Per-sample gain or mix. The first target snaps, matching `SampleGlide`.
#[derive(Clone, Copy, Debug)]
pub struct SampleGlide {
    value: f64,
    ready: bool,
    alpha: f64,
    rate: f64,
}

impl Default for SampleGlide {
    fn default() -> Self {
        Self {
            value: 0.0,
            ready: false,
            alpha: 0.0,
            rate: 0.0,
        }
    }
}

impl SampleGlide {
    pub fn prepare(&mut self, sample_rate: f64) {
        let rate = if sample_rate > 0.0 {
            sample_rate
        } else {
            48_000.0
        };
        if rate == self.rate && self.alpha > 0.0 {
            return;
        }
        self.rate = rate;
        self.alpha = sample_alpha(rate);
    }

    pub fn settled(&self) -> bool {
        self.ready
    }

    pub fn peek(&self) -> f64 {
        self.value
    }

    pub fn snap(&mut self, target: f64) -> f64 {
        self.value = if target.is_finite() { target } else { 0.0 };
        self.ready = true;
        self.value
    }

    pub fn next(&mut self, target: f64) -> f64 {
        let goal = if target.is_finite() { target } else { 0.0 };
        if !self.ready {
            return self.snap(goal);
        }
        if (self.value - goal).abs() < 1e-6 {
            self.value = goal;
            return goal;
        }
        self.value += (goal - self.value) * self.alpha;
        self.value
    }

    pub fn reset(&mut self) {
        self.ready = false;
        self.value = 0.0;
    }
}

pub fn glide_block(from: f64, to: f64, frames: usize, rate: f64) -> f64 {
    let start = if from.is_finite() { from } else { to };
    let target = if to.is_finite() { to } else { start };
    if (start - target).abs() < 1e-6 {
        return target;
    }
    let tau = PARAM_SMOOTH_SEC.clamp(0.005, 0.015);
    let resolved = if rate > 0.0 { rate } else { 48_000.0 };
    let denom = (tau * resolved).max(1.0);
    let steps = (frames.max(1)) as f64;
    let alpha = 1.0 - (-steps / denom).exp();
    start + (target - start) * alpha
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settled_value_does_not_move() {
        assert_eq!(glide_block(3.0, 3.0, 128, 48_000.0), 3.0);
        assert_eq!(glide_block(1.0, 1.0 + 1e-7, 128, 48_000.0), 1.0 + 1e-7);
    }

    #[test]
    fn block_step_moves_toward_the_target() {
        let next = glide_block(0.0, 6.0, 128, 48_000.0);
        assert!(next > 0.0 && next < 6.0);
        let tau = 0.01_f64;
        let alpha = 1.0 - (-128.0 / (tau * 48_000.0)).exp();
        assert!((next - 6.0 * alpha).abs() < 1e-12);
    }

    #[test]
    fn sample_and_block_use_the_same_time_constant() {
        let mut per_sample = 0.0;
        for _ in 0..128 {
            per_sample = glide_sample(per_sample, 6.0, 48_000.0);
        }
        let per_block = glide_block(0.0, 6.0, 128, 48_000.0);
        // One block step is the closed form of 128 sample steps, so they match closely.
        assert!((per_sample - per_block).abs() < 1e-9);
    }
}
