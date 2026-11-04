# CueHarbor engine architecture

This is a gap analysis of the current browser app against the professional DAW engine spec, plus the shape of the portable core. The spec was written for native iOS and Android. CueHarbor today is a browser DAW (React, TypeScript, Vite, Web Audio) at the repository root. The same contract is meant to move later, without starting that port in this change:

- Web: TypeScript now, then a shared Rust or C++ core compiled to WebAssembly.
- Native apps: that core on CoreAudio / AVAudioEngine (iOS) and Oboe / AAudio (Android).
- DAW plugin: the same core behind VST3, AU, and AAX.

Phase 1 (this change) adds the host-agnostic plugin contract and tightens the browser render loop. It does not change the mix, the meters' paint behavior, or the screen.

## How the spec maps onto the browser

| Spec idea | Web build | Native app / plugin build |
| --- | --- | --- |
| Render thread | AudioWorklet `process()` (`src/audio/insert.worklet.ts`). A ScriptProcessor remains only as a fallback in `src/audio/liveRack.ts`. | Real-time audio callback. No DOM and no Web Audio types in `src/audio/core`. |
| DSP core | TypeScript processors under `src/audio/plugins`. WASM later, only where a profiler says the TS loop is the limit. | Same processors compiled from the shared core. |
| Thread queues | MessagePort today. `SharedArrayBuffer` only when `crossOriginIsolated` is already true (`src/audio/engine.ts` key note path, `src/audio/core/meter.ts`). | Lock-free SPSC rings. |
| Buffer size | `AudioContext` `latencyHint` (`interactive`, then `balanced`) in `openContext` (`src/audio/engine.ts`). `baseLatency` and `outputLatency` are read for monitoring delay. | 64 / 128 / 256 / 512 / 1024 / 2048 sample callbacks. |
| Interruptions | `visibilitychange` in `src/App.tsx`, plus `AudioContext` `statechange` including iOS `interrupted` (`src/audio/core/session.ts`, `AudioEngine.recoverAudioSession`). | OS audio-session notifications. |
| Meters | DOM strips with `holdMeter` (`src/ui/levels.ts`, `src/ui/MixerView.tsx`, `src/ui/ArrangeView.tsx`) so a short drum hit stays visible. Canvas is used for waveforms and the tune graph, not as the mixer meter. | Metal (iOS) or Vulkan / OpenGL (Android). The plugin format's UI framework for VST3 / AU / AAX. |
| Plugin loading | JSON manifests from `pluginManifests()` (`src/audio/core/registry.ts`). Modules load through the existing registry (`src/audio/plugins/registry.ts`). | Compiled bundles. `dlopen` stays inside the native host, not in this contract. |

AAudio, Oboe, CoreAudio, `mmap`, Metal, Vulkan, and `dlopen` are not implemented. They are the native column above, not features the web build pretends to have.

`SharedArrayBuffer` needs `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`. Those headers break cross-origin loads this app depends on (Hugging Face sample libraries, the pinned jsDelivr ONNX runtime) and can break WebRTC video. The web build does not send them. The meter bus uses a plain `Float32Array` unless the page is already cross-origin isolated.

## 2. Core engine

### 2.1 Hard real-time audio

**What exists.** Insert DSP runs in `InsertProcessor.process` (`src/audio/insert.worklet.ts`). The chain is `processChain` (`src/audio/plugins/chain.ts`). Moving automation uses `processSampleAccurate` (`src/audio/automationRender.ts`). Track, send, and master delay compensation is `edgeDelays` (`src/audio/routing.ts`), applied with `DelayNode`s in `LiveRack.connectGraph` and again in the offline `renderGraph`.

**Phase 1.** The worklet prepares chain pools, automation scratch, parameter objects, and meter rows before `process()`. A steady 128, 256, or 512 sample quantum does not allocate those. Plugin internals that sized themselves on the first block are primed from the state message via `primeProcessor` (`src/audio/core/adapt.ts`). The master limiter's multi-stage buffer is reused (`series` in `src/audio/plugins/dispatch.ts`). There is still no lock and no `await` in `process()`.

**Not done.** Some plugin code (reverb, tune, the first block after a quantum the pool does not know) can still allocate. Offline rendering allocates on purpose. There is no user control for 64–2048 samples and no automatic buffer growth when the device is hot. Compensation lines up tracks, buses, and sends. It does not delay the dry path inside one plugin when wet is below 1, so a latent plugin that is not fully wet can still comb-filter.

### 2.2 Multi-core task graph

**What exists.** `renderGraph` (`src/audio/renderGraph.ts`) topologically sorts tracks, groups, and the master, and refuses a cycle (`findCycle` in `src/audio/routing.ts`). The live graph connects the same routes on one audio thread.

**Not done.** Independent tracks are not farmed out to worker cores. A browser cannot share the live `AudioContext` graph across threads without copying audio, so a multi-core scheduler waits on the native core.

### 2.3 Transport and timing

**What exists.** `projectSampleBeat` / `samplesAtBeat` (`src/model/tempoMap.ts`) convert beats and samples, including tempo ramps. Automation can be applied per sample (`processSampleAccurate`). Clips, count-in, and the step sequencer are scheduled against the audio clock in `src/audio/engine.ts`. MIDI notes into the insert worklet are still messages, not sample offsets inside the block. The new `MidiEvent.sampleOffset` field is on the contract. Legacy `note(pitch, velocity)` is called at the start of `processBlock`, which matches today's block delivery.

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

**Smoothing.** `ParamSmoother` and `BlockSmoother` (`src/audio/core/smooth.ts`) use the same 5–15 ms exponential approach as `glideValue` (`src/audio/paramCurve.ts`). The worklet smooths every numeric parameter once per block, which is what it already did, without building a new parameter object per quantum. Per-sample stepping is implemented and tested. Existing processors still receive one value per block, because calling them one sample at a time would change filters and look-ahead plugins.

**Meters.** `writeMeter` / `readMeter` (`src/audio/core/meter.ts`) are a single-writer cell. A short peak is held until `consumeMeter`. The mixer and arrange headers keep `holdMeter`, which is what makes a one-block drum hit readable. The worklet posts plugin meters on the existing MessagePort, reusing row objects, and includes the loudest output sample since the last post. Strip meters are still the `AnalyserNode` path in `AudioEngine.levels`.

**UI layout.** Manifests are JSON. Knobs stay the React controls already on screen. No Metal or Vulkan UI in the web build.

**Bundles.** `PluginManifest.module` is a registry id. A native host can later point that field at a compiled bundle. This build does not call `dlopen`.

## 4. Device integration

### 4.1 Drivers

Web: Web Audio. `openContext` asks for `interactive` latency, then `balanced`. Monitoring delay uses `baseLatency` and `outputLatency`.

Native app, not started: CoreAudio and AVAudioEngine on iOS, Oboe or AAudio on Android.

Plugin, not started: the format's audio callback (VST3, AU, AAX) calls `processBlock`.

### 4.2 Interruptions

`planRecovery` (`src/audio/core/session.ts`) chooses:

- hidden page: do nothing (the project is already flushed on `visibilitychange`)
- `suspended` or iOS `interrupted`: `AudioContext.resume()`
- `closed` or missing: rebuild the graph once

`AudioEngine.recoverAudioSession` keeps the project and the playhead. If playback was running and the device is actually running again, transport starts from that playhead. A device that stays interrupted is rebuilt at most once, so a tap does not tear the graph down on every try. `panic()` is unchanged and still returns the playhead home. An in-progress recording that was inside a closed context cannot be continued on the dead nodes. The project document is not discarded.

## 5. Checklist

| Feature | Web build | Native app / plugin build | Status | Required action |
| --- | --- | --- | --- | --- |
| Audio thread safety | Worklet chain, automation scratch, and meter rows are prepared. No `await` or logging in `process()`. Some plugin DSP can still allocate. | Same rule inside the audio callback. The shared core does not exist yet. | Partial | Phase 2: move remaining plugin buffers into `prepare`. |
| Graph scheduling | One audio thread. Topological sort for routes and offline render. | Worker threads per independent track, then buses. | Partial | Later native scheduler. Do not fake it with extra Web Audio nodes. |
| Plugin delay compensation | `edgeDelays` on track, send, and master, live and offline. Per-plugin `getLatencyInSamples`. | Same numbers inside the shared core. | Partial | Phase 3: delay the dry path of a latent plugin when wet is below 1. |
| Sample-accurate timing | Tempo map and automation are sample-accurate. MIDI into instruments is still block-quantized. | `MidiEvent.sampleOffset` splits the block. | Partial | Phase 4: split `processBlock` at MIDI offsets for instruments. |
| Plugin base | `NativePlugin` wraps the current processors, including tune, step sequencer, sampler / Beat Machine, and the synth. | Rust or C++ with the same fields. | Partial | Phase 5: one plugin compiled to WASM and checked against the TS processor. |
| Parameter smoothing | Block exponential glide on the worklet, same curve as before. Per-sample stepper exists and is not wired through legacy processors. | Per-sample in the core for gain-class parameters. | Partial | Phase 6: per-sample smoothing for parameters that are read every sample, leaving look-ahead and FFT plugins on a block value. |
| Mobile audio drivers | Web Audio `latencyHint`, `baseLatency`, `outputLatency`. | CoreAudio / AVAudioEngine and Oboe / AAudio. | Partial | Port track. No AAudio or CoreAudio code in this repo yet. |
| Interruption handling | `statechange` (`interrupted`, `suspended`, `closed`) and `visibilitychange`. Project and playhead are kept. | OS session notifications calling the same plan. | Partial | Confirm on a real iPhone. This environment cannot open an interrupted iOS context. |

## Roadmap

Each step is small enough to listen to on its own. Do not start the native port until the web phases that protect sound are in.

### Web

1. **Done here.** Portable `NativePlugin`, manifests, block smoothing, prepared worklet pools, latency reporting, the existing compensation pass, interruption recovery, meter hold.
2. **Stepped parameters.** Do not glide `kind` and other non-automatable integers. Listen to an EQ mode change and a Beat Machine / Sampler switch.
3. **Dry/wet alignment.** When a plugin reports latency and wet is below 1, delay the dry samples by that amount inside `processChain`. Compare a half-wet limiter to the fully wet and fully dry cases.
4. **Sample-offset MIDI.** Split instrument `processBlock` at `MidiEvent.sampleOffset`. Keys and pads should not move earlier or later when the offset is 0.
5. **Prepare the heavy plugins.** Reverb, tune, and convolution allocate their windows in `prepare`, not on the first `process`. Compare a recorded vocal before and after.
6. **Per-sample smoothing for simple gains.** Drive, mix, and output gain read the per-sample value. Look-ahead and pitch plugins keep one value per block.
7. **Buffer hint.** A setting maps to `latencyHint` and shows `baseLatency`. Count dropouts. Do not add COOP/COEP in this step.
8. **Isolation experiment.** Try COOP/COEP on a branch only if Hugging Face audio, jsDelivr ONNX, and a WebRTC call still load. If any of those break, keep the MessagePort meter.

### Shared core, app, and plugin

9. **Shared DSP core (started).** `core/` is a Cargo workspace. `cueharbor-dsp` mirrors `NativePlugin`: `prepare`, `process_block` (sample-offset MIDI on the trait; the EQ ignores it), parameter ids, `latency_in_samples`, and version-1 JSON state. `process_block` does not allocate. Block-sized WASM buffers and the plugin's mono scratch buffer are reserved in `prepare`. Parameters use the same 10 ms block glide as `glideValue`. `kind` does not glide. Per-sample glide is in the core for a later gain-class port. The first port is the clean five-band EQ in `src/audio/plugins/eq.ts` (`designBiquad`). Parameter ids match the live EQ manifest in `coreCatalog.ts` (version 2, `kind` then the clean bands, then the other model knobs). Those other knobs are stored so state round-trips. The kind switch in `dispatch.ts` is not ported. The TypeScript EQ still runs the live graph. `src/test/dsp-parity.test.ts` renders silence, sine, and noise through both and compares them. The WASM module is generated into `src/audio/wasm/dspBytes.ts` and bundled with the app. It loads only when `?wasmDsp=1` is set (or a test sets `__CUEHARBOR_WASM_DSP__`). That flag is off by default, and the insert chain does not call the loader.
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
node scripts/build-dsp.mjs
```

`cargo test` covers the EQ, the block glide, state, and a check that `process_block` does not allocate. It also builds the nih-plug shell and checks that the shell's stereo path matches the core. The same tests run with `--manifest-path core/Cargo.toml`. The default plugin build exports CLAP and VST3. `--no-default-features` exports CLAP only. `node scripts/build-dsp.mjs` writes the release WASM into `src/audio/wasm/dspBytes.ts`. `npm test` and `npm run build` run that script first. The bytes are small DSP code in the JS bundle, not a separate library or model file, and not loaded from Render or Cloudflare.

AU is not built here. It needs a macOS host. AAX is not started.

#### Licenses

`cueharbor-dsp` has no third-party audio code. nih-plug is ISC. CLAP (`clap-sys`) is MIT. The VST3 export links `vst3-sys`, which is GPLv3, so a VST3 build of `cueharbor-plugin` is a GPLv3 binary. The DSP crate does not depend on nih-plug, and the web app does not link the plugin shell. A proprietary VST3 later needs a permissive binding (the `vst3` crate used by the nice-plug fork) instead of `vst3-sys`. Nothing here is paid. The 750 GB relay cap is unchanged.

#### Next port steps

1. Port the compressor the same way, then the other inserts. Keep the TypeScript processor until the parity test is inside the same tolerance on sine, noise, and silence.
2. When a port is a simple gain, read `glide_sample` per sample. Leave the EQ, look-ahead, and pitch plugins on one value per block.
3. Turn the flag on inside the insert worklet for the EQ only, and listen to it against the TypeScript EQ. The loader is already behind the flag. Do not switch the default until that listen passes.
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
