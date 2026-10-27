"use strict";
(() => {
  // src/audio/quality/resample.ts
  var BESSEL_TERMS = 12;
  function bessel0(x) {
    let sum = 1;
    let term = 1;
    const half = x * 0.5;
    for (let k = 1; k <= BESSEL_TERMS; k++) {
      term *= half * half / (k * k);
      sum += term;
    }
    return sum;
  }
  function sinc(x) {
    if (Math.abs(x) < 1e-8) return 1;
    const p = Math.PI * x;
    return Math.sin(p) / p;
  }
  function resampleSinc(input, outLen, taps = 96) {
    const output = new Float32Array(Math.max(1, outLen | 0));
    if (input.length < 1) return output;
    if (input.length === 1 || output.length === 1) {
      output.fill(input[0] || 0);
      return output;
    }
    if (input.length === output.length) {
      output.set(input);
      return output;
    }
    const half = Math.max(8, Math.min(128, taps | 0));
    const scale = input.length / output.length;
    const fc = Math.min(0.45, 0.45 / Math.max(1, scale));
    const beta = 8.6;
    const i0 = bessel0(beta);
    for (let i = 0; i < output.length; i++) {
      const center = (i + 0.5) * scale - 0.5;
      const iCenter = Math.floor(center);
      let acc = 0;
      let norm = 0;
      for (let k = -half; k <= half; k++) {
        const idx = iCenter + k;
        const x = idx - center;
        const ratio = half <= 0 ? 0 : k / half;
        const inside = 1 - ratio * ratio;
        const win = inside > 0 ? bessel0(beta * Math.sqrt(inside)) / i0 : 0;
        const kernel = 2 * fc * sinc(2 * fc * x) * win;
        if (idx >= 0 && idx < input.length) acc += (input[idx] || 0) * kernel;
        norm += kernel;
      }
      output[i] = norm !== 0 ? acc / norm : 0;
    }
    return output;
  }

  // src/audio/plugins/dsp.ts
  function sanitize(sample) {
    if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0;
    return sample;
  }

  // src/audio/stretch/phase.ts
  var PROFILES = {
    pro: { fft: 4096, transient: 0.2 },
    tonal: { fft: 8192, transient: 0.07 },
    beats: { fft: 1024, transient: 0.42 },
    voice: { fft: 2048, transient: 0.18 },
    speech: { fft: 1024, transient: 0.28 },
    tape: { fft: 2048, transient: 0.18 }
  };
  function nextPow2(value) {
    let size = 64;
    while (size < value) size <<= 1;
    return size;
  }
  function princarg(phase) {
    return phase - 2 * Math.PI * Math.round(phase / (2 * Math.PI));
  }
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inverse ? 1 : -1);
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1;
        let wIm = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j];
          const uIm = im[i + j];
          const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
          const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + half] = uRe - vRe;
          im[i + j + half] = uIm - vIm;
          const nextRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nextRe;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
  function phaseStretch(input, outLen, sampleRate2, mode) {
    const length = Math.max(1, outLen);
    const output = new Float32Array(length);
    if (input.length < 2) {
      if (input.length === 1) output.fill(input[0] || 0);
      return output;
    }
    if (Math.abs(input.length - length) <= 1) {
      output.set(input.subarray(0, Math.min(input.length, length)));
      if (length > input.length) output[length - 1] = input[input.length - 1] || 0;
      return output;
    }
    const profile = PROFILES[mode] ?? PROFILES.pro;
    let size = nextPow2(Math.min(8192, Math.max(128, Math.round(profile.fft * (sampleRate2 / 48e3)))));
    while (size > input.length && size > 128) size >>= 1;
    const synthHop = Math.max(16, size >> 2);
    const ratio = length / input.length;
    const analysisHop = synthHop / ratio;
    const window = new Float64Array(size);
    for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
    const weight = new Float64Array(length);
    const half = size >> 1;
    const prevAna = new Float64Array(half + 1);
    const prevSyn = new Float64Array(half + 1);
    const prevMag = new Float64Array(half + 1);
    let primed = false;
    let inCursor = 0;
    const frames = Math.ceil(length / synthHop) + 2;
    for (let frame = 0; frame < frames; frame++) {
      const inAt = Math.max(0, Math.min(Math.round(inCursor), Math.max(0, input.length - size)));
      const outAt = frame * synthHop;
      if (outAt >= length) break;
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let i = 0; i < size; i++) re[i] = (input[inAt + i] || 0) * window[i];
      fft(re, im, false);
      const mag = new Float64Array(half + 1);
      const phase = new Float64Array(half + 1);
      let energy = 0;
      for (let bin = 0; bin <= half; bin++) {
        mag[bin] = Math.hypot(re[bin], im[bin]);
        phase[bin] = Math.atan2(im[bin], re[bin]);
        energy += mag[bin];
      }
      const synth = new Float64Array(half + 1);
      let transient = false;
      if (!primed) {
        for (let bin = 0; bin <= half; bin++) synth[bin] = phase[bin];
        primed = true;
      } else {
        let flux = 0;
        for (let bin = 1; bin < half; bin++) {
          const rise = mag[bin] - prevMag[bin];
          if (rise > 0) flux += rise;
        }
        transient = energy > 1e-8 && flux / energy > profile.transient;
        const peaks = [];
        const floor = energy / Math.max(1, half) * 4;
        for (let bin = 1; bin < half; bin++) {
          if (mag[bin] >= mag[bin - 1] && mag[bin] > mag[bin + 1] && mag[bin] > floor) peaks.push(bin);
        }
        const dIn = Math.max(1, analysisHop);
        for (let bin = 0; bin <= half; bin++) {
          const omega = 2 * Math.PI * bin / size;
          const delta = princarg(phase[bin] - prevAna[bin] - omega * dIn);
          const freq = omega + delta / dIn;
          const propagated = prevSyn[bin] + freq * synthHop;
          if (transient) synth[bin] = phase[bin];
          else {
            let peak = -1;
            let distance = 4;
            for (const candidate of peaks) {
              const gap = Math.abs(candidate - bin);
              if (gap < distance) {
                distance = gap;
                peak = candidate;
              }
            }
            synth[bin] = peak >= 0 ? prevSyn[peak] + freqOf(phase[peak], prevAna[peak], peak, size, dIn) * synthHop + princarg(phase[bin] - phase[peak]) : propagated;
          }
        }
      }
      for (let bin = 0; bin <= half; bin++) {
        prevAna[bin] = phase[bin];
        prevSyn[bin] = synth[bin];
        prevMag[bin] = mag[bin];
      }
      const outRe = new Float64Array(size);
      const outIm = new Float64Array(size);
      for (let bin = 0; bin <= half; bin++) {
        outRe[bin] = mag[bin] * Math.cos(synth[bin]);
        outIm[bin] = mag[bin] * Math.sin(synth[bin]);
        if (bin > 0 && bin < half) {
          outRe[size - bin] = outRe[bin];
          outIm[size - bin] = -outIm[bin];
        }
      }
      fft(outRe, outIm, true);
      const edge = frame === 0;
      for (let i = 0; i < size; i++) {
        const at = outAt + i;
        if (at < 0 || at >= length) continue;
        const shaped = edge && i < half ? 1 : window[i];
        output[at] += outRe[i] * shaped;
        weight[at] += window[i] * shaped;
      }
      inCursor += analysisHop;
      if (inAt >= input.length - size && frame > 0) break;
    }
    let typical = 0;
    const from = Math.floor(length * 0.2);
    const to = Math.max(from + 1, Math.floor(length * 0.8));
    for (let i = from; i < to; i++) if (weight[i] > typical) typical = weight[i];
    for (let i = 0; i < length; i++) {
      const covered = weight[i];
      if (!(covered > 1e-8) || !(typical > 0)) {
        output[i] = 0;
        continue;
      }
      const gain = covered >= typical * 0.5 ? 1 / covered : covered / (typical * typical * 0.5);
      output[i] = sanitize(output[i] * gain);
    }
    const onset = Math.min(length, input.length, Math.round(sampleRate2 * 6e-3));
    for (let i = 0; i < onset; i++) {
      const gain = i / onset;
      output[i] = (input[i] || 0) * (1 - gain) + output[i] * gain;
    }
    return output;
  }
  function freqOf(phase, prev, bin, size, dIn) {
    const omega = 2 * Math.PI * bin / size;
    return omega + princarg(phase - prev - omega * dIn) / dIn;
  }

  // src/audio/stretch/voice.ts
  function sanitize2(sample) {
    if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0;
    return sample;
  }
  function hann(index, length) {
    if (length <= 1) return 1;
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (length - 1));
  }
  function yinPitch(frame, sampleRate2, minHz, maxHz) {
    const n = frame.length;
    const tauMin = Math.max(2, Math.floor(sampleRate2 / Math.max(40, maxHz)));
    const tauMax = Math.min(Math.floor(n / 2) - 2, Math.floor(sampleRate2 / Math.max(40, minHz)));
    if (tauMax <= tauMin + 2) return { hz: 0, confidence: 0 };
    let energy = 0;
    for (let i = 0; i < n; i++) energy += frame[i] * frame[i];
    if (energy / n < 1e-8) return { hz: 0, confidence: 0 };
    const diff = new Float32Array(tauMax + 1);
    for (let tau2 = tauMin; tau2 <= tauMax; tau2++) {
      let sum = 0;
      for (let i = 0; i < n - tau2; i += 2) {
        const delta = frame[i] - frame[i + tau2];
        sum += delta * delta;
      }
      diff[tau2] = sum;
    }
    const cmnd = new Float32Array(tauMax + 1);
    let running = 0;
    cmnd[tauMin] = 1;
    for (let tau2 = tauMin; tau2 <= tauMax; tau2++) {
      running += diff[tau2];
      cmnd[tau2] = running > 0 ? diff[tau2] * tau2 / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (cmnd[t] < 0.18) {
        while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      let best = tauMin;
      for (let t = tauMin + 1; t <= tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
      if (cmnd[best] > 0.5) return { hz: 0, confidence: clamp01(1 - cmnd[best]) };
      tau = best;
    }
    const prev = cmnd[Math.max(0, tau - 1)];
    const mid = cmnd[tau];
    const next = cmnd[Math.min(tauMax, tau + 1)];
    const denom = prev + next - 2 * mid;
    const shift = denom === 0 ? 0 : (prev - next) / (2 * denom);
    const period = Math.max(1, tau + shift);
    return { hz: sampleRate2 / period, confidence: clamp01(1 - mid) };
  }
  function clamp01(value) {
    return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  }
  var Psola = class {
    latencySamples;
    channels;
    span;
    ring;
    mix;
    weight;
    written = 0;
    nextOut = 0;
    emitted = 0;
    epoch = 0;
    epochSet = false;
    constructor(sampleRate2, channels = 2) {
      this.channels = Math.max(1, Math.min(2, channels));
      this.span = Math.max(1024, Math.round(1536 * (sampleRate2 / 48e3)));
      this.latencySamples = this.span + Math.floor(this.span / 2);
      const size = this.span * 8;
      this.ring = Array.from({ length: this.channels }, () => new Float32Array(size));
      this.mix = Array.from({ length: this.channels }, () => new Float32Array(size));
      this.weight = new Float32Array(size);
    }
    reset() {
      for (const buffer of this.ring) buffer.fill(0);
      for (const buffer of this.mix) buffer.fill(0);
      this.weight.fill(0);
      this.written = 0;
      this.nextOut = 0;
      this.emitted = 0;
      this.epoch = 0;
      this.epochSet = false;
    }
    process(input, output, targetFor, sampleRate2, minHz, maxHz, analyzeEvery) {
      const n = input[0]?.length ?? 0;
      const hop = Math.max(32, Math.round(analyzeEvery));
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < this.channels; c++) {
          this.ring[c][this.written % this.ring[c].length] = input[Math.min(c, input.length - 1)]?.[i] ?? 0;
        }
        this.written += 1;
        this.synthesize(targetFor, sampleRate2, minHz, maxHz, hop);
        const sample = this.take(hop);
        for (let c = 0; c < output.length; c++) output[c][i] = sample[Math.min(c, sample.length - 1)] ?? 0;
      }
    }
    synthesize(targetFor, sampleRate2, minHz, maxHz, hop) {
      let guard = 0;
      while (this.written - this.nextOut > this.span && guard < 4) {
        guard += 1;
        const frame = new Float32Array(this.span);
        for (let i = 0; i < this.span; i++) frame[i] = this.read(0, this.nextOut - this.span + i);
        const pitch = yinPitch(frame, sampleRate2, minHz, maxHz);
        const target = targetFor(pitch);
        const voiced = pitch.hz > 0 && pitch.confidence >= 0.7 && target > 30;
        if (!voiced) {
          this.epochSet = false;
          this.stamp(this.nextOut, this.nextOut, hop, false);
          this.nextOut += hop;
          continue;
        }
        const period = clamp(Math.round(sampleRate2 / pitch.hz), 8, Math.floor(this.span / 2));
        const outPeriod = clamp(Math.round(sampleRate2 / target), 8, Math.floor(this.span / 2));
        if (!this.epochSet) {
          this.epoch = this.nextOut;
          this.epochSet = true;
        }
        const mark = this.epoch + Math.round((this.nextOut - this.epoch) / period) * period;
        const grain = clamp(period * 2, 16, this.span - 1);
        this.stamp(mark, this.nextOut, grain, true);
        this.nextOut += outPeriod;
      }
    }
    /** Repeat the pitch-locked input grain at the target spacing. */
    stamp(inputCenter, outputCenter, grain, windowed) {
      const half = Math.floor(grain / 2);
      for (let i = 0; i < grain; i++) {
        const at = outputCenter - half + i;
        if (at < this.emitted) continue;
        const win = windowed ? hann(i, grain) : 1;
        const slot = at % this.weight.length;
        this.weight[slot] += win;
        for (let c = 0; c < this.channels; c++) this.mix[c][slot] += this.read(c, inputCenter - half + i) * win;
      }
    }
    take(hop) {
      const ready = this.nextOut - Math.max(hop, Math.floor(this.span / 2));
      if (this.emitted >= ready) return this.channels === 2 ? [0, 0] : [0];
      const slot = this.emitted % this.weight.length;
      const weight = this.weight[slot];
      const sample = [];
      for (let c = 0; c < this.channels; c++) {
        sample.push(sanitize2(weight > 1e-5 ? this.mix[c][slot] / weight : 0));
        this.mix[c][slot] = 0;
      }
      this.weight[slot] = 0;
      this.emitted += 1;
      return sample;
    }
    read(channel, index) {
      if (index < 0 || index >= this.written) return 0;
      return this.ring[channel][index % this.ring[channel].length];
    }
  };
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  // src/audio/stretch/engine.ts
  var MODES = ["pro", "beats", "tonal", "voice", "speech", "tape"];
  function pitchFactor(semitones = 0, cents = 0) {
    return 2 ** ((semitones + cents / 100) / 12);
  }
  function detectTransients(channel, sampleRate2, threshold = 0.2) {
    let peak = 0;
    for (let i = 0; i < channel.length; i++) {
      const mag = Math.abs(channel[i] || 0);
      if (mag > peak) peak = mag;
    }
    if (peak < 1e-8) return [];
    const gate = Math.max(0.02, threshold) * peak;
    const minGap = Math.max(1, Math.round(sampleRate2 * 0.03));
    const hits = [];
    let last = -minGap;
    for (let index = 1; index < channel.length - 1; index++) {
      const mag = Math.abs(channel[index] || 0);
      if (mag < gate || mag < Math.abs(channel[index - 1] || 0) || mag <= Math.abs(channel[index + 1] || 0)) continue;
      if (index - last < minGap) continue;
      hits.push(index);
      last = index;
    }
    return hits;
  }
  function formantEnabled(mode, formant) {
    if (formant != null) return formant;
    return mode === "voice" || mode === "speech";
  }
  function renderStretch(channels, sampleRate2, options) {
    const stream = new StretchStream(Math.max(1, channels.length), sampleRate2, options);
    stream.push(channels);
    return stream.flush();
  }
  var StretchStream = class {
    constructor(channelCount, sampleRate2, options) {
      this.channelCount = channelCount;
      this.sampleRate = sampleRate2;
      this.options = options;
    }
    channelCount;
    sampleRate;
    options;
    chunks = [];
    received = 0;
    rendered = null;
    readAt = 0;
    /** Append input. Samples are committed only once the same input the offline render sees is complete. */
    push(channels) {
      const length = channels[0]?.length ?? 0;
      if (length <= 0 || this.rendered) return this.empty();
      const copy = [];
      for (let c = 0; c < this.channelCount; c++) copy.push(Float32Array.from(channels[Math.min(c, channels.length - 1)] ?? new Float32Array(length)));
      this.chunks.push(copy);
      this.received += length;
      return this.empty();
    }
    flush() {
      if (!this.rendered) this.rendered = this.synthesize();
      return this.pull(this.rendered[0].length - this.readAt);
    }
    synthesize() {
      const input = join(this.chunks, this.channelCount);
      const length = input[0]?.length ?? 0;
      const ratio = clampRatio(this.options.ratio);
      const outLen = Math.max(1, Math.round(length * ratio));
      const mode = normalizeMode(this.options.mode);
      const semis = this.options.semitones || 0;
      const cents = this.options.cents || 0;
      const quality = this.options.quality === "preview" ? "preview" : "hq";
      const formant = formantEnabled(mode, this.options.formant);
      if (length < 1) return [new Float32Array(outLen)];
      const factor = pitchFactor(semis, cents);
      if (Math.abs(ratio - 1) < 1e-6 && Math.abs(factor - 1) < 1e-4 && mode !== "tape") return fitChannels(input, outLen);
      return input.map((channel) => renderChannel(channel, outLen, this.sampleRate, mode, semis, cents, quality, formant));
    }
    pull(count) {
      const rendered = this.rendered ?? this.empty();
      const start = this.readAt;
      const end = Math.min(rendered[0]?.length ?? 0, start + Math.max(0, count));
      this.readAt = end;
      return rendered.map((channel) => channel.subarray(start, end));
    }
    empty() {
      return Array.from({ length: this.channelCount }, () => new Float32Array(0));
    }
  };
  function renderChannel(input, outLen, sampleRate2, mode, semitones, cents, quality, formant) {
    const factor = pitchFactor(semitones, cents);
    if (mode === "tape") {
      const varied = resampleTo(input, outLen, quality);
      if (Math.abs(factor - 1) < 1e-4) return varied;
      if (formant) return formantShift(varied, sampleRate2, factor);
      const pitched2 = resampleTo(varied, Math.max(1, Math.round(varied.length / factor)), quality);
      return timeStretch(pitched2, outLen, "pro", sampleRate2, quality);
    }
    if (Math.abs(factor - 1) < 1e-4) return timeStretch(input, outLen, mode, sampleRate2, quality);
    if (formant) return formantShift(timeStretch(input, outLen, mode, sampleRate2, quality), sampleRate2, factor);
    const pitched = resampleTo(input, Math.max(1, Math.round(input.length / factor)), quality);
    return timeStretch(pitched, outLen, mode, sampleRate2, quality);
  }
  function formantShift(input, sampleRate2, factor) {
    if (input.length < 64 || Math.abs(factor - 1) < 1e-4) return Float32Array.from(input);
    const psola = new Psola(sampleRate2, 1);
    const output = new Float32Array(input.length);
    psola.process([input], [output], (frame) => frame.hz > 0 && frame.confidence >= 0.65 ? frame.hz * factor : 0, sampleRate2, 50, 1600, 128);
    return output;
  }
  function timeStretch(input, outLen, mode, sampleRate2, quality = "hq") {
    const length = Math.max(1, outLen);
    if (input.length < 2) return resampleTo(input, length, quality);
    if (Math.abs(input.length - length) <= 1 && mode !== "tape") {
      const copy = new Float32Array(length);
      copy.set(input.subarray(0, Math.min(input.length, length)));
      if (length > input.length) copy[length - 1] = input[input.length - 1] || 0;
      return copy;
    }
    if (mode === "tape") return resampleTo(input, length, quality);
    if (mode === "beats") return stretchBeats(input, length, sampleRate2, quality);
    if (quality === "preview") return wsola(input, length, mode);
    return phaseStretch(input, length, sampleRate2, mode);
  }
  function stretchBeats(input, outLen, sampleRate2, quality) {
    const hits = detectTransients(input, sampleRate2, 0.2);
    if (!hits.length) return quality === "preview" ? wsola(input, outLen, "beats") : phaseStretch(input, outLen, sampleRate2, "beats");
    const bounds = [0, ...hits, input.length];
    const output = new Float32Array(outLen);
    const attack = Math.max(1, Math.round(sampleRate2 * 0.012));
    for (let i = 0; i < bounds.length - 1; i++) {
      let src0 = bounds[i];
      const src1 = bounds[i + 1];
      let out0 = Math.round(src0 / input.length * outLen);
      const out1 = i === bounds.length - 2 ? outLen : Math.round(src1 / input.length * outLen);
      if (hits.includes(src0)) {
        const copy = Math.min(attack, src1 - src0, Math.max(0, out1 - out0));
        for (let k = 0; k < copy; k++) output[out0 + k] = input[src0 + k] || 0;
        src0 += copy;
        out0 += copy;
      }
      const srcLen = src1 - src0;
      const dstLen = out1 - out0;
      if (srcLen < 1 || dstLen < 1) continue;
      const body = input.subarray(src0, src1);
      const piece = srcLen < 32 || dstLen < 32 ? resampleTo(body, dstLen, quality) : quality === "preview" ? wsola(body, dstLen, "beats") : phaseStretch(body, dstLen, sampleRate2, "beats");
      output.set(piece.subarray(0, Math.min(piece.length, output.length - out0)), out0);
    }
    return output;
  }
  function resampleTo(input, outLen, quality) {
    return resampleSinc(input, outLen, quality === "hq" ? 96 : 24);
  }
  function wsola(input, outLen, mode) {
    if (input.length < 8 || outLen < 8) return resampleLinear(input, outLen);
    const output = new Float32Array(outLen);
    const weight = new Float32Array(outLen);
    let win = mode === "beats" || mode === "speech" ? 512 : mode === "voice" ? 1024 : 2048;
    win = Math.min(win, input.length);
    win = Math.max(32, win - win % 2);
    const hs = Math.max(8, Math.min(outLen, Math.floor(win / 2)));
    const ratio = outLen / input.length;
    const ha = hs / ratio;
    const overlap = Math.max(8, win - hs);
    const radius = Math.min(mode === "beats" ? 64 : 128, Math.max(8, overlap - 1), Math.max(0, input.length - win));
    let inPos = 0;
    let outPos = 0;
    const frames = Math.ceil(outLen / hs) + 4;
    for (let frame = 0; frame < frames && outPos < outLen; frame++) {
      const room = Math.max(0, input.length - win);
      const natural = Math.max(0, Math.min(Math.round(inPos), room));
      const start = frame === 0 || radius < 1 ? natural : seekOutput(output, weight, outPos, input, natural, overlap, radius, win);
      const grain = Math.min(win, input.length - start);
      if (grain < 8) break;
      addGrain(output, weight, input, start, outPos, grain);
      outPos += hs;
      inPos += ha;
    }
    for (let i = 0; i < outLen; i++) output[i] = weight[i] > 1e-5 ? output[i] / weight[i] : 0;
    return output;
  }
  function seekOutput(output, weight, outAt, input, ideal, overlap, radius, win) {
    const maxStart = input.length - win;
    if (maxStart <= 0) return 0;
    const center = Math.max(0, Math.min(maxStart, ideal));
    const span = Math.min(overlap, output.length - outAt);
    if (span < 8) return center;
    let best = center;
    let bestScore = -Infinity;
    const step = radius > 40 ? 4 : 1;
    const scoreAt = (at) => {
      let corr = 0;
      let left = 0;
      let right = 0;
      for (let i = 0; i < span; i += 4) {
        const w = weight[outAt + i];
        if (w < 1e-5) continue;
        const a = output[outAt + i] / w;
        const b = input[at + i] || 0;
        corr += a * b;
        left += a * a;
        right += b * b;
      }
      return corr / Math.sqrt(left * right + 1e-12);
    };
    for (let delta = -radius; delta <= radius; delta += step) {
      const at = center + delta;
      if (at < 0 || at > maxStart) continue;
      const score = scoreAt(at);
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    const from = Math.max(0, best - step);
    const to = Math.min(maxStart, best + step);
    for (let at = from; at <= to; at++) {
      const score = scoreAt(at);
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    return best;
  }
  function addGrain(output, weight, input, inAt, outAt, grain) {
    const limit = Math.min(grain, output.length - outAt, input.length - inAt);
    for (let i = 0; i < limit; i++) {
      const window = grain <= 1 ? 1 : 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (grain - 1));
      const dest = outAt + i;
      if (dest < 0 || dest >= output.length) continue;
      output[dest] += (input[inAt + i] || 0) * window;
      weight[dest] += window;
    }
  }
  function resampleLinear(input, outLen) {
    return resampleSinc(input, outLen, 64);
  }
  function fitChannels(channels, length) {
    return channels.map((channel) => {
      if (channel.length === length) return channel;
      const next = new Float32Array(length);
      next.set(channel.subarray(0, Math.min(length, channel.length)));
      return next;
    });
  }
  function join(parts, channelCount) {
    const length = parts.reduce((sum, part) => sum + (part[0]?.length ?? 0), 0);
    const channels = Array.from({ length: channelCount }, () => new Float32Array(length));
    let offset = 0;
    for (const part of parts) {
      const n = part[0]?.length ?? 0;
      for (let c = 0; c < channelCount; c++) channels[c].set(part[Math.min(c, part.length - 1)] ?? new Float32Array(n), offset);
      offset += n;
    }
    return channels;
  }
  function clampRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0) return 1;
    return Math.min(8, Math.max(0.125, ratio));
  }
  function normalizeMode(mode) {
    return mode && MODES.includes(mode) ? mode : "pro";
  }

  // src/audio/stretch/worklet-entry.ts
  var CueStretchProcessor = class extends AudioWorkletProcessor {
    rendered = null;
    startFrame = 0;
    skip = 0;
    end = 0;
    constructor() {
      super();
      this.port.onmessage = (event) => {
        const data = event.data;
        if (!data || data.type !== "stretch" || !data.channels?.length) return;
        const channels = data.channels.map((channel) => Float32Array.from(channel));
        const options = { ratio: 1, ...data.options, quality: data.options?.quality ?? "preview" };
        this.rendered = renderStretch(channels, data.sampleRate || sampleRate, options);
        this.startFrame = data.startFrame ?? 0;
        this.skip = data.skip ?? 0;
        this.end = this.skip + (data.frames ?? this.rendered[0].length);
      };
    }
    process(_inputs, outputs) {
      const out = outputs[0];
      const rendered = this.rendered;
      if (!out?.[0] || !rendered?.[0]) return true;
      const count = out[0].length;
      let alive = currentFrame + count < this.startFrame;
      for (let i = 0; i < count; i++) {
        const frame = currentFrame + i;
        const at = frame - this.startFrame + this.skip;
        const on = frame >= this.startFrame && at >= this.skip && at < this.end;
        if (on) alive = true;
        for (let c = 0; c < out.length; c++) {
          const src = rendered[Math.min(c, rendered.length - 1)];
          out[c][i] = on && at < src.length ? src[at] : 0;
        }
      }
      return alive;
    }
  };
  registerProcessor("cueharbor-stretch", CueStretchProcessor);
})();
