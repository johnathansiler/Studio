/**
 * Tiny key classifiers trained in this process. Weights stay in the lab.
 * They are not imported by the app, so they do not change the bundle.
 */

import { rotateChroma, type Truth } from './evaluate.ts'

export interface MlpModel {
  mean: number[]
  std: number[]
  w: number[][]
  bytes: number
}

export interface CnnModel {
  mean: number
  std: number
  conv: number[][]
  convB: number[]
  fc: number[][]
  fcB: number[]
  bytes: number
}

export interface Example {
  chroma: number[]
  bass: number[]
  start: number[]
  end: number[]
  cqt: number[][]
  truth: Truth
}

function argmax(values: ArrayLike<number>) {
  let best = 0
  let peak = -Infinity
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i]
      best = i
    }
  }
  return best
}

function classOf(truth: Truth) {
  return truth.root * 2 + (truth.mode === 'minor' ? 1 : 0)
}

function truthOf(index: number): Truth {
  return { root: index >> 1, mode: index % 2 === 1 ? 'minor' : 'major' }
}

function featuresOf(example: Example, semitones: number) {
  const turn = (row: number[]) => rotateChroma(row, semitones)
  return [...turn(example.chroma), ...turn(example.bass), ...turn(example.start), ...turn(example.end)]
}

function rollCqt(cqt: number[][], semitones: number) {
  return cqt.map((row) => {
    const out = new Array<number>(row.length)
    for (let i = 0; i < row.length; i++) out[i] = row[(i - semitones + row.length * 4) % row.length]
    return out
  })
}

function softmax(logits: Float64Array) {
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i]
  let sum = 0
  const out = new Float64Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    out[i] = Math.exp(logits[i] - max)
    sum += out[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= sum || 1
  return out
}

export function trainMlp(examples: Example[], epochs = 70): MlpModel {
  const augmented: { x: number[]; y: number }[] = []
  for (const example of examples) {
    for (let k = 0; k < 12; k++) {
      const truth = { root: (example.truth.root + k) % 12, mode: example.truth.mode }
      augmented.push({ x: featuresOf(example, k), y: classOf(truth) })
    }
  }
  const dim = 48
  const mean = new Array<number>(dim).fill(0)
  const std = new Array<number>(dim).fill(0)
  for (const row of augmented) for (let i = 0; i < dim; i++) mean[i] += row.x[i]
  for (let i = 0; i < dim; i++) mean[i] /= augmented.length
  for (const row of augmented) for (let i = 0; i < dim; i++) {
    const d = row.x[i] - mean[i]
    std[i] += d * d
  }
  for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i] / augmented.length) || 1
  const w = Array.from({ length: dim + 1 }, () => Array.from({ length: 24 }, () => (Math.random() - 0.5) * 0.02))
  const lr = 0.18
  const l2 = 1e-4
  const logits = new Float64Array(24)
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let s = augmented.length - 1; s > 0; s--) {
      const j = Math.floor(Math.random() * (s + 1))
      const swap = augmented[s]
      augmented[s] = augmented[j]
      augmented[j] = swap
    }
    for (const row of augmented) {
      for (let y = 0; y < 24; y++) {
        let sum = w[dim][y]
        for (let i = 0; i < dim; i++) sum += ((row.x[i] - mean[i]) / std[i]) * w[i][y]
        logits[y] = sum
      }
      const probs = softmax(logits)
      probs[row.y] -= 1
      for (let y = 0; y < 24; y++) {
        const grad = probs[y]
        for (let i = 0; i < dim; i++) w[i][y] -= lr * (grad * ((row.x[i] - mean[i]) / std[i]) + l2 * w[i][y])
        w[dim][y] -= lr * grad
      }
    }
  }
  const bytes = (dim + 1) * 24 * 4 + dim * 2 * 4
  return { mean, std, w, bytes }
}

export function predictMlp(model: MlpModel, example: Example) {
  const x = featuresOf(example, 0)
  const logits = new Float64Array(24)
  const dim = 48
  for (let y = 0; y < 24; y++) {
    let sum = model.w[dim][y]
    for (let i = 0; i < dim; i++) sum += ((x[i] - model.mean[i]) / model.std[i]) * model.w[i][y]
    logits[y] = sum
  }
  const probs = softmax(logits)
  const index = argmax(probs)
  return { ...truthOf(index), probability: probs[index], runner: Math.max(...Array.from(probs).filter((_, i) => i !== index)) }
}

export function trainCnn(examples: Example[], epochs = 8): CnnModel {
  const channels = 8
  const kernel = 12
  const conv = Array.from({ length: channels }, () => Array.from({ length: kernel }, () => (Math.random() - 0.5) * 0.08))
  const convB = new Array<number>(channels).fill(0)
  const fc = Array.from({ length: channels }, () => Array.from({ length: 24 }, () => (Math.random() - 0.5) * 0.08))
  const fcB = new Array<number>(24).fill(0)
  let mean = 0
  let count = 0
  for (const example of examples) for (const row of example.cqt) for (const value of row) {
    mean += value
    count++
  }
  mean = count ? mean / count : 0
  let variance = 0
  for (const example of examples) for (const row of example.cqt) for (const value of row) {
    const d = value - mean
    variance += d * d
  }
  const std = Math.sqrt(variance / Math.max(1, count)) || 1
  const augmented: { x: number[][]; y: number }[] = []
  for (const example of examples) {
    for (let k = 0; k < 12; k++) {
      const truth = { root: (example.truth.root + k) % 12, mode: example.truth.mode }
      augmented.push({ x: rollCqt(example.cqt, k), y: classOf(truth) })
    }
  }
  const lr = 0.05
  const positions = 72 - kernel + 1
  const pool = 4 * positions
  const logits = new Float64Array(24)
  const hidden = new Float64Array(channels)
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (let s = augmented.length - 1; s > 0; s--) {
      const j = Math.floor(Math.random() * (s + 1))
      const swap = augmented[s]
      augmented[s] = augmented[j]
      augmented[j] = swap
    }
    const step = lr / (1 + epoch * 0.25)
    for (const row of augmented) {
      hidden.fill(0)
      for (let t = 0; t < 4; t++) {
        const frame = row.x[t]
        for (let p = 0; p < positions; p++) {
          for (let c = 0; c < channels; c++) {
            let acc = convB[c]
            const filter = conv[c]
            for (let k = 0; k < kernel; k++) acc += filter[k] * ((frame[p + k] - mean) / std)
            if (acc > 0) hidden[c] += acc
          }
        }
      }
      for (let c = 0; c < channels; c++) hidden[c] /= pool
      for (let y = 0; y < 24; y++) {
        let sum = fcB[y]
        for (let c = 0; c < channels; c++) sum += hidden[c] * fc[c][y]
        logits[y] = sum
      }
      const probs = softmax(logits)
      probs[row.y] -= 1
      const dh = new Float64Array(channels)
      for (let c = 0; c < channels; c++) {
        for (let y = 0; y < 24; y++) dh[c] += fc[c][y] * probs[y]
      }
      for (let c = 0; c < channels; c++) {
        for (let y = 0; y < 24; y++) fc[c][y] -= step * (hidden[c] * probs[y] + 1e-4 * fc[c][y])
      }
      for (let y = 0; y < 24; y++) fcB[y] -= step * probs[y]
      const conv0 = conv.map((row) => row.slice())
      const bias0 = convB.slice()
      for (let t = 0; t < 4; t++) {
        const frame = row.x[t]
        for (let p = 0; p < positions; p++) {
          for (let c = 0; c < channels; c++) {
            let acc = bias0[c]
            const filter0 = conv0[c]
            for (let k = 0; k < kernel; k++) acc += filter0[k] * ((frame[p + k] - mean) / std)
            if (acc <= 0) continue
            const grad = dh[c] / pool
            convB[c] -= step * grad
            const filter = conv[c]
            for (let k = 0; k < kernel; k++) filter[k] -= step * grad * ((frame[p + k] - mean) / std)
          }
        }
      }
    }
  }
  const bytes = (channels * kernel + channels + channels * 24 + 24) * 4
  return { mean, std, conv, convB, fc, fcB, bytes }
}

export function predictCnn(model: CnnModel, cqt: number[][]) {
  const channels = model.conv.length
  const kernel = model.conv[0].length
  const positions = 72 - kernel + 1
  const pool = 4 * positions
  const hidden = new Float64Array(channels)
  for (let t = 0; t < 4; t++) {
    const frame = cqt[t]
    for (let p = 0; p < positions; p++) {
      for (let c = 0; c < channels; c++) {
        let acc = model.convB[c]
        const filter = model.conv[c]
        for (let k = 0; k < kernel; k++) acc += filter[k] * ((frame[p + k] - model.mean) / model.std)
        if (acc > 0) hidden[c] += acc
      }
    }
  }
  for (let c = 0; c < channels; c++) hidden[c] /= pool
  const logits = new Float64Array(24)
  for (let y = 0; y < 24; y++) {
    let sum = model.fcB[y]
    for (let c = 0; c < channels; c++) sum += hidden[c] * model.fc[c][y]
    logits[y] = sum
  }
  const probs = softmax(logits)
  const index = argmax(probs)
  return { ...truthOf(index), probability: probs[index] }
}

export function modelBytes(model: { bytes: number }) {
  return model.bytes
}
