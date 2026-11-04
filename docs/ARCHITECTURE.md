# CueHarbor engine architecture

This is a gap analysis of the current browser app against the professional DAW engine spec, plus the shape of the portable core. The spec was written for native iOS and Android. CueHarbor today is a browser DAW (React, TypeScript, Vite, Web Audio) at the repository root. The same contract is meant to move later, without starting that port in this change:

- Web: TypeScript now, then a shared Rust or C++ core compiled to WebAssembly.
- Native apps: that core on CoreAudio / AVAudioEngine (iOS) and Oboe / AAudio (Android).
- DAW plugin: the same core behind VST3, AU, and AAX.

Phase 1 added the host-agnostic plugin contract and tightened the browser render loop. Phase 2, this change, makes stepped parameters jump, smooths simple gains per sample, delays a latent plugin's dry path, splits instrument blocks on MIDI sample offsets, prepares the heavy plugin windows, and adds a latency setting. It does not change the meters' paint behavior. The native port in `core/` is a separate builder and is not part of this change.

## How the spec maps onto the browser

| Spec idea | Web build | Native app / plugin build |
| --- | --- | --- |
| Render thread | AudioWorklet `process()` (`src/audio/insert.worklet.ts`). A ScriptProcessor remains only as a fallback in `src/audio/liveRack.ts`. | Real-time audio callback. No DOM and no Web Audio types in `src/audio/core`. |
| DSP core | TypeScript processors under `src/audio/plugins`. WASM later, only where a profiler says the TS loop is the limit. | Same processors compiled from the shared core. |
| Thread queues | MessagePort today. `SharedArrayBuffer` only when `crossOriginIsolated` is already true (`src/audio/engine.ts` key note path, `src/audio/core/meter.ts`). | Lock-free SPSC rings. |
| Buffer size | Settings → Latency offers Lowest, Balanced, and Playback. Those are `AudioContext` `latencyHint` values `interactive`, `balanced`, and `playback` (`src/audio/core/buffer.ts`, `openContext` in `src/audio/engine.ts`). The same row shows measured base and output latency. | 64 / 128 / 256 / 512 / 1024 / 2048 sample callbacks. |
| Interruptions | `visibilitychange` in `src/App.tsx`, plus `AudioContext` `statechange` including iOS `interrupted` (`src/audio/core/session.ts`, `AudioEngine.recoverAudioSession`). | OS audio-session notifications. |
| Meters | DOM strips with `holdMeter` (`src/ui/levels.ts`, `src/ui/MixerView.tsx`, `src/ui/ArrangeView.tsx`) so a short drum hit stays visible. Canvas is used for waveforms and the tune graph, not as the mixer meter. | Metal (iOS) or Vulkan / OpenGL (Android). The plugin format's UI framework for VST3 / AU / AAX. |
| Plugin loading | JSON manifests from `pluginManifests()` (`src/audio/core/registry.ts`). Modules load through the existing registry (`src/audio/plugins/registry.ts`). | Compiled bundles. `dlopen` stays inside the native host, not in this contract. |

AAudio, Oboe, CoreAudio, `mmap`, Metal, Vulkan, and `dlopen` are not implemented. They are the native column above, not features the web build pretends to have.

The Render server sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on static files (`server/headers.ts`). `credentialless` is what keeps Google fonts, Hugging Face fetches, and jsDelivr loads working: no-cors responses do not need `Cross-Origin-Resource-Policy`. `require-corp` would block the font stylesheet. WebRTC and TURN are not page subresources, so the call stays on the same document. Safari ignores `credentialless`, `crossOriginIsolated` stays false, and playback stays on one thread. Chromium gets `SharedArrayBuffer` and may run independent insert chains on workers.

Checked on 4 Nov 2026, without turning the headers on:

- **jsDelivr would survive.** `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort-wasm-simd-threaded.wasm` answered `Cross-Origin-Resource-Policy: cross-origin` and `Access-Control-Allow-Origin: *`. The pinned ONNX runtime can load under `require-corp`.
- **Hugging Face fetches would survive. A no-cors embed would not.** The stem weight at `huggingface.co/.../resolve/main/htdemucs_fp16weights.onnx`, requested with `Origin: https://cueharbor.onrender.com`, answered `Access-Control-Allow-Origin: https://cueharbor.onrender.com` and redirected to a CDN that answered `Access-Control-Allow-Origin: *`. Neither response sent `Cross-Origin-Resource-Policy`. This app loads libraries and stem weights with `fetch()`, which is CORS mode, so `require-corp` allows them. An audio or image tag without CORS would be blocked because the CORP header is missing.
- **WebRTC should survive, and was not placed under the headers.** Calls, `getUserMedia`, and Cloudflare TURN are not cross-origin page subresources. `same-origin` COOP would drop `window.opener` for a cross-origin popup. This app joins the call in the same page. A live call on an isolated document was not run, so the headers stay off.

## 2. Core engine

### 2.1 Hard real-time audio

**What exists.** Insert DSP runs in `InsertProcessor.process` (`src/audio/insert.worklet.ts`). The chain is `processChain` (`src/audio/plugins/chain.ts`). Moving automation uses `processSampleAccurate` (`src/audio/automationRender.ts`). Track, send, and master delay compensation is `edgeDelays` (`src/audio/routing.ts`), applied with `DelayNode`s in `LiveRack.connectGraph` and again in the offline `renderGraph`.

**Phase 1.** The worklet prepares chain pools, automation scratch, parameter objects, and meter rows before `process()`. A steady 128, 256, or 512 sample quantum does not allocate those. Plugin internals that sized themselves on the first block are primed from the state message via `primeProcessor` (`src/audio/core/adapt.ts`). The master limiter's multi-stage buffer is reused (`series` in `src/audio/plugins/dispatch.ts`). There is still no lock and no `await` in `process()`.

**Phase 2.** Reverb modes, the tune and amp analysis windows, linear-EQ FFT scratch, and the insert scratch pairs are built before `process`. EQ parameter checks no longer build a JSON string on the audio thread. The worklet prepares chain and automation buffers for 128, 256, 512, 1024, and 2048 sample quanta. A steady quantum in that range does not allocate those. A quantum above 2048, or a note slice's buffer view on the block that contains a MIDI event, can still allocate once. Offline rendering still allocates its output buffers on purpose. There is no automatic buffer growth when the device is hot. The latency setting is the buffer control that exists on the web.

**Phase 2 delay.** When a plugin reports latency and wet is below 1, `processChain` delays the dry samples by that amount before the crossfade. Track, send, and master edges use `reportedLatency`, which is the larger of the catalog formula and the processor's own `latencySamples` (the worklet posts that number). A pure delay at half wet matches the fully wet path. Parallel branches that `compensateGraph` lines up cancel.

### 2.2 Multi-core task graph

**What exists.** Tracks, sends, buses, and the master are a DAG in `src/audio/core/graph.ts`. That file has no DOM and no Web Audio types. `scheduleRoutes` topologically orders the graph, builds parallel waves, and refuses a feedback route. The refusal text names the loop (`Feedback route refused: a → b → a`). The store shows that text and does not apply the route. `walkLatency` is the dependency latency: a node's output time is its own latency plus the slowest input, and each edge is delayed so the inputs of the next node arrive together. `compensateGraph` (`src/audio/core/latency.ts`) returns that delay map, which is the PDC pass the live `DelayNode`s and the offline renderer already apply.

`createScheduler` is the pull queue. `take` returns a node whose inputs are finished, or nothing. `complete` releases whatever was waiting only on that node. A bus stays pending until the tracks that feed it finish. The worker that finished is not blocked on the bus; it takes the next ready track. `renderGraph` walks the same order on one thread. `LiveRack.connectGraph` still connects those routes on the audio thread.

**Web parallelism.** Realtime multi-core is not available in this browser build, and it was not faked.

- One `AudioContext` runs every `AudioWorklet` `process` on a single audio thread, in graph order. A second worklet does not add a core. The live rack already has one worklet per track, and they still share that thread.
- Splitting a 128-sample callback across `Worker`s copies the block. `SharedArrayBuffer` would avoid the copy, and it needs COOP/COEP. Those headers stay off. A warm worker round trip for one quantum was slower than rendering that quantum on the calling thread, so it would add dropouts rather than remove them.
- Extra `AudioContext`s are not sample-locked to each other, so they cannot hold the PDC delays.

Offline bounce can wait. `renderGraphParallel` (`src/audio/parallelRender.ts`) uses the pull scheduler. In the browser the bounce worker spawns module workers (`src/audio/workers/track.browser.ts`). In Node the same jobs use `worker_threads` (`src/audio/nodePool.ts`). A sidechain mix stays on one thread so the key hears the same audio as the sequential render. If the workers fail to start, bounce uses the single-thread render. Playback, sends, and meters are unchanged.

`benchmarkMixGraph` (`src/audio/graphBench.ts`, `src/test/graph-schedule.test.ts`) builds tracks with EQ, compressor, and saturator, plus a bus and a send. It sums prepared insert chains for a 128-sample quantum and counts a dropout when that sum exceeds the buffer (2.67 ms at 48 kHz). It also times the sequential offline mix against the worker mix. On the 4-core machine that added this section, 8 tracks and 0.75 s took 1858 ms on one thread and 687 ms on 4 workers (2.71×), and the samples matched. The same quantum took 8.29 ms on one thread and 13.53 ms through workers. Both overran the 128-sample budget; the worker path overran by more. Realtime before and after are the same numbers, because the audio thread was not split.

**Native plan.** The callback owns a pool of workers and runs this scheduler. `take` and `complete` are the only coordination. Buses are ordinary nodes with dependencies. No lock is held while a bus waits. The web types stay out of `src/audio/core/graph.ts`.

**Realtime.** When the page is cross-origin isolated, `measureRealtime` times one quantum on shared memory. The pool is kept only when workers finish inside the buffer and beat one thread. Eligible tracks (no sampler, Beat Machine, synth, or sidechain) then hand the quantum to that pool from the insert worklet and play the previous block, so the audio thread copies instead of running the chain. A miss streak falls back to the audio thread. Buses and the master stay on the audio thread so a send is not delayed a second block. On the 4-core machine that added this, 8 tracks with EQ, compressor, and saturator took 9.36 ms on one thread and 4.01 ms across workers (5.34 ms less). The audio-thread handoff was 0.44 ms. The 128-sample budget is 2.67 ms, so that heavy quantum is not adopted and the audio thread keeps the chain. The samples matched. The native plan is unchanged: the callback's own workers run `take` / `complete`.

### 2.3 Transport and timing

**What exists.** `projectSampleBeat` / `samplesAtBeat` (`src/model/tempoMap.ts`) convert beats and samples, including tempo ramps. Automation of a cheap gain can be applied per sample (`processSampleAccurate`). A look-ahead or pitch plugin keeps one value for the block. Clips, count-in, and the step sequencer are scheduled against the audio clock in `src/audio/engine.ts`. `processBlock` and the insert chain split at `MidiEvent.sampleOffset`, so a note starts on that sample. The worklet turns a note message's audio-clock time into an offset inside the current quantum. Sampler `schedule` was already sample-accurate and is left on that path. A note at offset 0 matches a note that starts the block.

### 2.4 Memory and streaming

**What exists.** Long multisamples can be read in resident chunks (`src/audio/multisample/stream.ts`). Arrangement audio is decoded into `AudioBuffer`s. There is no `mmap` and no background ring that prefetches from disk ahead of the playhead. The browser does not expose iOS jetsam. RAM control is "do not decode the world at once" (`STREAM_FRAMES` in the multisample stream).

### 2.5 Routing and mixing

**What exists.** Tracks are stereo. Sends are pre-fader or post-fader (`src/audio/liveRack.ts`, `src/model/types.ts` `Send`). Sidechain keys are mono (`src/audio/sidechain.ts`) and tapped pre-fader. Groups and link groups exist (`groupId`, `src/model/mixGroups.ts`). Link groups move faders, mutes, solos, and edits together. They are not VCA groups with a separate audio path. There is no surround or other multichannel bus.

### 2.6 Arranger

**What exists.** Clips are trimmed, split, and slipped by editing bounds, not by rewriting samples (`src/model/clips.ts`, `src/model/edit.ts`). Comp fades are linear (`src/model/comp.ts`). Time-stretch and pitch live in `src/audio/stretch` (phase vocoder and PSOLA). Region-boundary micro-fades are not applied on every audio clip edge.

## 3. Plugin framework

### 3.1 Standard interface

`NativePlugin` in `src/audio/core/contract.ts` mirrors `NativePluginBase`:

- `prepare` / `release` / `reset`
- `processBlock(audio, midi)` with sample-offset MIDI events
- `setParameter` / `getParameter` / `getNumParameters` by numeric id
- `getLatencyInSamples`
- `getState` / `setState` as a small versioned JSON blob
- `layout()` for declarative controls (the web stand-in for a JSON UI descriptor)

`adaptProcessor` (`src/audio/core/adapt.ts`) wraps the existing `Processor` (`src/audio/plugins/types.ts`). Tune, EQ, the compressor, the limiter, the synth, and the sampler are created by `createNativePlugin` (`src/audio/core/registry.ts`) through `createProcessor`. They are not rewritten.

The step sequencer is a sequencer shell (`adaptSequencer`). Its patterns stay on the project (`src/model/stepPlugin.ts`). It does not render inside the insert worklet, which already skips `steps`. Beat Machine is Sampler kind 1 (`KIND_LABELS` in `src/audio/plugins/ids.ts`). Kind 1 still passes audio through and the pads play from the engine, as before.

Parameter ids are the index of the control in the manifest. Appending a control is safe. Reordering is not.

The live worklet still calls `processor.process` directly so the sound path stays the one already shipping. The adapter calls that same function after one block of smoothing. A settled knob matches a direct `process` call.

### 3.2 Architecture principles

**Smoothing.** `ParamSmoother` and `BlockSmoother` (`src/audio/core/smooth.ts`) use the same 5–15 ms exponential approach as `glideValue` (`src/audio/paramCurve.ts`). Stepped and enum parameters, including `kind` and `mode`, jump to the new value. Gain, pan, mix, drive, output, and the insert wet crossfade move one sample at a time (`SampleGlide`) so a knob does not zipper. Look-ahead and pitch plugins still receive one value per block. Cheap automation, such as a gain lane, is applied per sample. A moving control on a look-ahead plugin stays one value for that block.

**Meters.** `writeMeter` / `readMeter` (`src/audio/core/meter.ts`) are a single-writer cell. A short peak is held until `consumeMeter`. The mixer and arrange headers keep `holdMeter`, which is what makes a one-block drum hit readable. The worklet posts plugin meters on the existing MessagePort, reusing row objects, and includes the loudest output sample since the last post. Strip meters are still the `AnalyserNode` path in `AudioEngine.levels`.

**UI layout.** Manifests are JSON. Knobs stay the React controls already on screen. No Metal or Vulkan UI in the web build.

**Bundles.** `PluginManifest.module` is a registry id. A native host can later point that field at a compiled bundle. This build does not call `dlopen`.

## 4. Device integration

### 4.1 Drivers

Web: `src/audio/core/driver.ts` picks the hint when the listener has not saved one. iOS Safari asks for Balanced (256 samples) on the speaker or a wired output and Playback (1024) on Bluetooth. Android Chrome asks for Lowest (128) unless the output is Bluetooth, which asks for Balanced. A saved Settings choice still wins. A sample-rate change or a wired/Bluetooth switch rebuilds the context. A latency jump on the same route resumes it. iOS will not leave `suspended` until the first tap. Output latency is added to the recording shift and to the monitoring total. It is not inserted as a DelayNode, which would delay the speaker by the hardware buffer again.

Native app, not started: CoreAudio and AVAudioEngine on iOS, Oboe or AAudio on Android. The same policy is what that port should keep.

Plugin, not started: the format's audio callback (VST3, AU, AAX) calls `processBlock`.

### 4.2 Interruptions

`planRecovery` (`src/audio/core/session.ts`) chooses:

- hidden page: do nothing (the project is already flushed on `visibilitychange`)
- `suspended` or iOS `interrupted`: `AudioContext.resume()`
- `closed` or missing: rebuild the graph once

`planInterruption` names the cause: a call or Siri (`interrupted` on iOS), another app, the screen locking (a phone hiding the page), or a background tab. Playback pauses, the playhead stays, and a recording is assembled up to that moment and returned by the next `finishRecording` so the take is not dropped when the context dies. A status line (`cueharbor-session-notice`) says which of those happened. It is not a dialog. When the page is visible again and the device is running, playback continues from the same playhead. `panic()` is unchanged and still returns the playhead home. The project document is not discarded.

## 5. Checklist

| Feature | Web build | Native app / plugin build | Status | Required action |
| --- | --- | --- | --- | --- |
| Audio thread safety | Steady 128–2048 sample quanta reuse prepared chain, automation, meter, reverb, tune, and EQ windows. No `await` or logging in `process()`. A larger quantum, and the buffer view for a block that contains a MIDI note, can still allocate once. Offline bounce still allocates its output. | Same rule inside the audio callback. The shared core is a separate port and was not changed here. | Pass | None on the web render thread for a normal quantum. Keep new plugin windows in `prepare`. |
| Graph scheduling | DAG in `src/audio/core/graph.ts`. Offline bounce and, when COOP/COEP `credentialless` isolates the page, realtime insert quanta share memory with workers. The pool is used only if it beats one thread inside the buffer. Otherwise the audio thread keeps the chain. Safari stays single-thread. | The same pull scheduler on the audio callback's worker pool. | Pass | Confirm a Chromium phone shows `crossOriginIsolated`. iOS Safari ignores `credentialless`. |
| Plugin delay compensation | Dry path of a latent plugin is delayed when wet is below 1. Track, send, and master edges use the reported latency, live and offline. | Same numbers inside the shared core. | Pass | None for the mix graph. A plugin that reports the wrong latency will still be compensated to that wrong number. |
| Sample-accurate timing | Tempo map, cheap automation, and instrument notes use sample offsets. A note at offset 0 matches a note at the start of the block. | `MidiEvent.sampleOffset` splits the block. | Pass | Clip-edge fades are still not applied on every audio region. That is the arranger row, not this one. |
| Plugin base | The live insert chain is the Rust core by default. Sampler and Beat Machine pad voices use the same sample pool (`VoiceEngine` / `SamplePool`). `?wasmDsp=0`, or a failed fetch, runs the TypeScript pool. The chop UI calls `pad.setRegion`, `pad.setPitch`, `pad.setVintage`, `pad.setFilter`, `pad.setChokeGroup`, `pad.setReverse`, `pad.setHold`, and `pad.setSwing`. | `core/dsp/src/voice.rs` is that pool: sixteen pads, shared buffers, vinyl or granular stretch, vintage, filters, choke, reverse, hold or one-shot, and swing. No Web Audio types. `process` does not allocate. The nih-plug shell is still the EQ only. | Pass | Native apps and the multi-output plugin are not built yet. Whole-file time-stretch of a sampler recording stays on the host. |
| Parameter smoothing | Stepped and enum values jump. Gain, pan, mix, drive, output, and wet move per sample. Look-ahead and pitch plugins keep one value per block. | Per-sample in the core for gain-class parameters. | Pass | None for the web processors that read those gains in their sample loop. |
| Mobile audio drivers | iOS Safari and Android Chrome pick a latency hint from the output route. Sample-rate and Bluetooth/wired changes rebuild the context. Output latency shifts the recording and the monitoring total, not a second DelayNode. | CoreAudio / AVAudioEngine and Oboe / AAudio using the same hint and route rules. | Partial | Listen on a real iPhone and Android for a Bluetooth switch and a sample-rate change. No AAudio or CoreAudio code in this repo. |
| Interruption handling | Call, Siri, another app, screen lock, and a hidden tab pause playback, keep the playhead, finalize a take up to that moment, and show a status line. Visible again resumes from that playhead. | OS session notifications calling the same plan. | Partial | Place a real call, trigger Siri, lock the screen, and background the tab on a phone. |

## Roadmap

Each step is small enough to listen to on its own. Do not start the native port until the web phases that protect sound are in.

### Web

1. **Done.** Portable `NativePlugin`, manifests, block smoothing, prepared worklet pools, latency reporting, the existing compensation pass, interruption recovery, meter hold.
2. **Done here.** Stepped parameters jump. `kind`, `mode`, and the other enum ids are not glided.
3. **Done here.** When a plugin reports latency and wet is below 1, the dry samples are delayed inside `processChain`. A half-wet pure delay matches the fully wet delay. Track, send, and master alignment uses the reported latencies.
4. **Done here.** Instrument `processBlock` splits at `MidiEvent.sampleOffset`. A note at offset 0 matches a note at the start of the block. The worklet maps an audio-clock note onto an offset in the current quantum.
5. **Done here.** Reverb modes, tune and amp analysis windows, and the linear-EQ FFT scratch are allocated before `process`. A normal worklet quantum reuses the chain pool.
6. **Done here.** Drive, mix, output gain, pan, and the wet crossfade move per sample. Look-ahead and pitch plugins keep one value per block.
7. **Done here.** Settings → Latency maps to `latencyHint` and shows measured base and output latency. COOP/COEP were not added.
8. **Investigated, not enabled.** jsDelivr would survive `require-corp`. Hugging Face CORS fetches would survive; a no-cors embed would not. WebRTC should survive and was not tested under the headers. The MessagePort meter stays.

### Shared core, app, and plugin

9. **Shared DSP core (website default).** `core/` is a Cargo workspace. `cueharbor-dsp` mirrors `NativePlugin`: `prepare`, `process_block` (sample-offset MIDI; the synth uses it, the inserts ignore it), parameter ids, `latency_in_samples`, and version-1 JSON state. `process_block` does not allocate. Delay lines, reverb, tune, limiter, and cabinet windows are reserved in `prepare`. `kind` does not glide. Mix, drive, and the other gain-class knobs that glide inside a TypeScript processor use the same per-sample curve. The host still applies one block value before `process`, including stepped jumps. The port is the kind switch from `dispatch.ts`: tune, every EQ kind (the offline linear-phase EQ included), compressor, vocal, saturator (soft, tape, sum, oxide, clip, and the amp/cabinet), reverb, delay, mod, and limiter. The synth is ported. Scaler is a passthrough. Sampler and Beat Machine pad voices are the sample pool in `core/dsp/src/voice.rs` (and `src/audio/voices/engine.ts` when `?wasmDsp=0`). The host loads each buffer once. Pads 0–15, both banks, call `pad.setRegion(sampleId, start, end)` to play a slice of that buffer, with a short fade in and fade out. `pad.setPitch(semis, cents, mode)` is `'vinyl'` (resample; speed and pitch move together) or `'stretch'` (a fixed-grain pitch shift that keeps the region’s duration; it does not allocate in `process`). `pad.setVintage({ bitDepth, sampleRate, wow, flutter, noise, crackle, lowpass })` is the character stage. `SP1200` is 12-bit at 26.04 kHz and `MPC60` is 12-bit at 40 kHz. `pad.setFilter(highpassHz, lowpassHz)`, `pad.setChokeGroup(n)`, `pad.setReverse(on)`, `pad.setHold(on)` (hold, otherwise one-shot), and `pad.setSwing(samples)` are per pad. `pool.note(offset, pad, velocity)` is sample-accurate; velocity 0 releases a hold. The same names are on the TypeScript fallback. Whole-file sampler stretch still runs on the host before the buffer is handed to the pool. `src/test/dsp-parity.test.ts` compares the TypeScript processors and the WASM inserts across sample rates, block sizes, factory presets, and parameter glides. Most inserts match bit for bit. The amp cabinet and the look-ahead limiter stay under 1e-5; those paths quantize an impulse or a windowed sinc to f32. The WASM module is generated into `src/audio/wasm/dspBytes.ts`. A dynamic `import()` loads that chunk for the default chain, after the first gesture or when idle, and again inside the worklet. `?wasmDsp=0` skips the chunk and forces the TypeScript processors. If the chunk fails to fetch or instantiate, the TypeScript processors run instead. Wet mix and dry-path delay compensation stay in the TypeScript chain, using the latency the core reports. The core does not take a Web Audio type, so the same `process_block` can later run on iOS, Android, and a plugin host that assigns each CueHarbor track its own output.
10. **App shell.** Wrap the current web app in Capacitor so it installs on a phone. Audio stays Web Audio. This proves the UI, not the driver.
11. **Native audio engine.** Replace the Capacitor audio path with AVAudioEngine / CoreAudio on iOS and Oboe / AAudio on Android. The callback calls `processBlock`. Web Audio remains the browser build.
12. **VST3 and AU.** A plugin that loads a CueHarbor session, talks, and records. The remote path stays the existing collab stack. RTAS is discontinued. AAX replaced it. Do not target RTAS. The EQ shell in `core/plugin` is the format proof, not that session plugin.
13. **AAX.** Same plugin, after an Avid developer account and Avid signing. Unsigned AAX will not load in Pro Tools. No Avid SDK in this repo.

#### Build the shared core

From the repository root, with Rust stable and the `wasm32-unknown-unknown` target:

```bash
cargo test
cargo test --manifest-path core/Cargo.toml
cargo build -p cueharbor-plugin
cargo build -p cueharbor-plugin --no-default-features
npm run build:dsp
```

`cargo test` covers the EQ, the block glide, state, a check that `process_block` does not allocate, and the same check for the ported compressor, reverb, and limiter. It also builds the nih-plug shell and checks that the shell's stereo path matches the core. The shell is still the EQ only; this port does not add CLAP or VST3 exports. The same tests run with `--manifest-path core/Cargo.toml`. The default plugin build exports CLAP and VST3. `--no-default-features` exports CLAP only. `npm run build:dsp` rewrites `src/audio/wasm/dspBytes.ts` and `src/audio/wasm/dspBytes.sha256` from a release WASM build. `npm run build` calls the same script, which rebuilds when `cargo` is on `PATH` and otherwise keeps the committed module. The app build does not need Rust. CI hashes a fresh WASM build and fails if it differs from that committed module. The bytes are small DSP code in their own chunk, fetched for the default chain and skipped when `?wasmDsp=0` is set. They are not a model file, and they are not loaded from Render or Cloudflare.

AU is not built here. It needs a macOS host. AAX is not started.

#### Licenses

`cueharbor-dsp` has no third-party audio code. nih-plug is ISC. CLAP (`clap-sys`) is MIT. The VST3 export links `vst3-sys`, which is GPLv3, so a VST3 build of `cueharbor-plugin` is a GPLv3 binary. The DSP crate does not depend on nih-plug, and the web app does not link the plugin shell. A proprietary VST3 later needs a permissive binding (the `vst3` crate used by the nice-plug fork) instead of `vst3-sys`. Nothing here is paid. The 750 GB relay cap is unchanged.

#### Next port steps

1. **Done.** The website runs the Rust insert chain by default. `?wasmDsp=0` is the TypeScript escape hatch. The parity harness stays inside 1e-5.
2. Port the sampler, including its sample binding, and the Beat Machine voice player. Both stay on the host for now. The synth and the scaler passthrough are already in the core.
3. The host chain still owns wet mix, dry-path delay compensation, and sample-offset slicing. Leave that mixer in TypeScript. It is the piece a native callback and a multi-output plugin will call around `process_block`.
4. Wrap the current UI in Capacitor. Leave the audio on Web Audio for that step.
5. Add the CoreAudio / Oboe callback that calls `process_block`.
6. Build the session plugin (talk and record) on the CLAP/VST3 shell. The remote path stays the existing collab stack.
7. Add AU on a Mac build. Add AAX only after Avid signing.
8. Before shipping a closed-source VST3, swap `vst3-sys` for a permissive binding.

## Files added for Phase 1

- `src/audio/core/contract.ts` — blocks, MIDI, layout, `NativePlugin`
- `src/audio/core/adapt.ts` — wrap an existing processor, prime it, sequencer shell
- `src/audio/core/registry.ts` — JSON manifests and `createNativePlugin`
- `src/audio/core/smooth.ts` — per-sample and per-block smoothing
- `src/audio/core/latency.ts` — sum and graph compensation
- `src/audio/core/session.ts` — interruption plan
- `src/audio/core/meter.ts` — peak cell with hold
- `src/test/engine-core.test.ts`

Phase 2 adds `src/audio/core/buffer.ts` and `src/test/engine-phase2.test.ts`.
