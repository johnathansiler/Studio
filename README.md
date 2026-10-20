# CueHarbor

Remote vocal sessions, captured inside the DAW. CueHarbor is a browser studio: multitrack arrange, mixer, clip launcher, a small piano roll, and a mesh WebRTC room so an artist can sing to the session from another browser window.

True zero latency over the internet is impossible. The live monitor is as short as the path allows. The printed take is recorded on the artist’s machine and aligned to the host timeline, so the recording does not keep the network delay.

## Open it from a link

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/johnathansiler/Studio)

Click **Deploy to Render** and sign in with GitHub. Render reads `render.yaml`, builds `main`, and gives you a public URL such as `https://cueharbor.onrender.com` (the name can differ). The build runs `npm ci --include=dev` because Render sets `NODE_ENV=production`, which would otherwise skip TypeScript and Vite. `npm start` still runs the server in production. Create an invite in the app and press **Copy invite link**. The artist opens `https://that-host/?session=CODE` — no install. HTTPS is what the browser requires for the mic and camera. Signaling is `wss` on that same origin (`/ws`), derived from the page URL.

This environment has no Render, Fly, or Railway credentials, so the app was not published from here. The button above is the whole account step.

A free Render instance sleeps after 15 minutes with no HTTP request and no WebSocket message, then takes about a minute to wake. Rooms live in memory, so a sleep or restart clears them. While people are connected, WebSocket traffic keeps the free instance awake.

The same image runs elsewhere:

- Docker: `docker build -t cueharbor . && docker run -p 8787:8787 -e PORT=8787 cueharbor`, then open http://localhost:8787
- Fly.io: install the `fly` CLI, run `fly auth login`, then `fly launch --copy-config --no-deploy` and `fly deploy`. `fly.toml` is already in the repo; change `app` if that name is taken.
- Railway: new project from this GitHub repo. `railway.json` points at the Dockerfile and the `/api/health` check. Sign in when Railway asks.

`GET /api/health` returns `{ "ok": true, "service": "cueharbor" }`. The process listens on `PORT` (default 8787) and `HOST` (default `0.0.0.0`).

## TURN for real networks

Signaling (join, admit, the arrangement, play and stop) uses the WebSocket. Video, the live guest microphone, and the direct take upload use a WebRTC peer connection. Without a TURN relay, two browsers on different networks often never connect: the guest still hears the backing, because that audio was sent over the socket, but the host sees no video and the printed guide is a flat line.

CueHarbor asks Cloudflare Realtime TURN for a short-lived credential and hands that to the browsers. Cloudflare charges **$0.05 per GB** sent from their network to the client. There is no monthly fee. (TURN is free only when it is used with Cloudflare’s own SFU. CueHarbor does not use that SFU.)

Set this up once on the existing Render service:

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Open the account, then **Realtime** → **TURN**. You can also use the dashboard search and type `TURN`.
3. Create a TURN key. Copy the **key ID** and the **API token**. The token is shown once. These are not the username and password the browser uses.
4. In Render, open the `cueharbor` service → **Environment**.
5. Add `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`. Save. Render restarts the service.
6. Open `https://your-host/api/ice`. The JSON should list `turn.cloudflare.com` and `"turn": "cloudflare"`.
7. Start a new session. The signal panel should say the media path connected, directly or through TURN.

The server calls `POST https://rtc.live.cloudflare.com/v1/turn/keys/$CF_TURN_KEY_ID/credentials/generate-ice-servers` with `Authorization: Bearer $CF_TURN_API_TOKEN`. `GET /api/ice` and each session welcome read `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` at request time. A working credential is cached for 30 minutes; a missing relay is not cached, and changing those variables drops the cache immediately. Adding them in Render and redeploying is enough. Credentials expire after an hour. The browser never sees the API token.

If Cloudflare is not set, these still work as a fallback, in order: `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` (any coturn or static server; comma-separated URLs are allowed); then `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`; then `METERED_DOMAIN` and `METERED_API_KEY`. `ICE_TRANSPORT_POLICY=relay` forces the relay, which is how the local coturn check is run.

When the data channel never opens, the guest posts the take to `/api/takes` in chunks and the server forwards it to the host. That uses Render bandwidth in both directions. A one-minute mono 48 kHz 16-bit vocal is about 5.8 MB each way. Takes over 32 MB are refused. A take whose peak is under 0.001 is still placed, and the host is told it is silent.

## Run it locally

```bash
npm install && npm run dev
```

Open http://localhost:5173. That starts Vite on port 5173 and the signaling server on port 8787. Vite proxies `/api` and `/ws`.

Two windows, one session: click **Create invite**, then **Copy invite link**. Open that URL in the second window, enter a name, and join. The host admits them from the **people** tab. Arm is automatic: Record prints a live guide, then replaces it with the guest’s aligned take.

Production is one process. It serves the built app and the signaling WebSocket on the same port:

```bash
npm run build
npm start
```

Open http://localhost:8787. `npm start` is what Render and the Docker image run (`NODE_ENV=production`, Node 22). Node 22.6 or newer is required.

```bash
npm test
```

## What you can do

Arrange: record-arm, mic record, play, stop, loop, metronome, tempo, time signature, bars/beats and timecode, per-track volume, pan, mute, solo, and monitor. Clips move, trim, split, and fade. Zoom and scroll the timeline. Undo and redo. Import audio, bounce a WAV, or write a `.cueharbor.json` file. The open project autosaves to IndexedDB, including recorded audio, and a refresh restores it.

Mix: channel strips and a master bus. Each strip can insert a shelf/peak EQ, a compressor, a delay, or a convolution reverb.

Session: eight scenes. Launch a clip and it loops from the next beat.

Keys: select the MIDI clip to open a piano roll. A simple synth plays the notes. There is no hardware MIDI and no third-party plugin format.

Remote room: gallery and speaker views, active speaker, camera and talkback toggles, device pickers, screen share, chat, reactions, raise hand, waiting room, admit, remove, and host mute. The video dock resizes and can pop out (Chromium picture-in-picture). Headphones on.

Phones and foldables use the same app. A portrait phone shows one full-height pane at a time — Arrange, Mix, or Session — and tucks Save, import, and the other tools into Menu. A short landscape phone keeps that single pane. A half-folded table-top posture, from CSS viewport segments or the Device Posture API, keeps video on the top half and transport on the bottom. The artist view is the simple screen: video, a mic meter, a headphone reminder, and record status. The first tap unlocks the audio device, a screen wake lock stays on during a live session, and the app can be installed from the manifest. The session code stays in the address bar. After a refresh the same device rejoins as the same host or guest; iOS shows one Tap to reconnect button when the microphone needs a new gesture. The room stays up for 10 minutes after the last person leaves so that reconnect takes the same seat.

## Latency

Physics first. A packet cannot cross a network in zero time. CueHarbor splits the problem in two.

**Live monitor.** The artist hears the cue as soon as the path can deliver it. On this machine — localhost, Chrome, fake media devices — that estimate was **45–46 ms ± 8 ms**. Almost all of it is the audio device, not the network.

**Printed take.** The guest records locally, in time with what they heard, and uploads the full-quality WAV. The host places it on the timeline with the cue path removed. The recording is on the grid even when the monitor was late. In the same localhost runs the compensation was **56 ms** (the monitor path plus a 10 ms input estimate).

### Measured on localhost

Chrome, `--use-fake-device-for-media-stream`, signaling and both peers on one machine. Headless and a normal window agreed. These are device numbers. A real WAN adds about half the round trip on top of the output latency, and the printed take subtracts that too.

| Quantity | Measured |
| --- | --- |
| Round trip (ICE candidate pair) | 0–1 ms |
| Clock-sync round trip | 0.4–0.7 ms |
| Jitter | 0.0 ms |
| Packet loss | 0.0% |
| AudioContext output latency (`baseLatency + outputLatency`) | 40–41 ms |
| Input estimate (no loopback cable) | 10 ms |
| Live monitor, stats path | 45–46 ms ± 8 ms |
| Printed-take compensation | 56 ms (55.5 ms of path + input) |

Chrome did not report `jitterBufferEmittedCount` here, so the buffer row in the dock stays “—” until the browser emits it. The stats estimate then treats the buffer as 0 ms and carries ± half a frame of uncertainty.

### How the monitor stays short

- `AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })`.
- Capture and playout run in AudioWorklets (`public/worklets/`).
- Music is Opus, forced in SDP: `ptime` and `minptime` and `maxptime` 10 ms (browsers floor Opus at 10 ms even though libopus can do 2.5), 48 kHz stereo (`stereo=1;sprop-stereo=1;maxplaybackrate=48000`), `usedtx=0`, `cbr=0`, `maxaveragebitrate` 510 kbps, in-band FEC on. The music sender is `priority` and `networkPriority` high, with `maxBitrate` 510000. Video is a separate, tiny stream (about 320×240, 15 fps, 150 kbps, priority very-low) so it gives bandwidth to the music first. Printed takes are the local uncompressed WAV, not this Opus stream.
- Music receivers ask for `playoutDelayHint = 0` and `jitterBufferTarget = 0` where the browser allows it. Talkback keeps a 20 ms jitter target.
- Music capture disables echo cancellation, noise suppression, and auto gain, and sets `contentHint = 'music'`. Talkback is a second capture with processing on and `contentHint = 'speech'`.
- The room is a full mesh. There is no SFU hop. ICE tries a direct path first. Cloudflare TURN, or the static `TURN_URL` fallback, is there when a NAT blocks that path. The signal panel shows whether media is direct, relayed, or failed.
- An optional **PCM** monitor (the dock toggle, off by default) sends 10 ms float frames on an unreliable data channel. Playout targets `max(18 ms, median network + 8 ms)`. Uncompressed stereo PCM is about 1.5 Mbps and has no FEC and no congestion control, so Opus stays the default on a real network. Alignment uses whichever path the artist actually heard.

The cue tap is the master bus before the monitor delay and before remote returns. The artist does not hear their own voice coming back through the mix. Metronome clicks are in the cue. Talkback is a separate bus.

### Clock

Host and guest exchange NTP-style pings on a data channel, with the signaling socket as a fallback:

```
offset = ((t1 − t0) + (t2 − t3)) / 2
rtt    = (t3 − t0) − (t2 − t1)
```

`hostPerf ≈ guestPerf + offset`. The kept sample is the one with the smallest round trip. `AudioContext` time is fit to `performance.now()` on each side (`perfAtCtx0 = perf − ctx × 1000`) and refreshed often. That fit is about ±3 ms.

One-way cue delay, in order of preference:

1. PCM: network median + playout target + output latency.
2. Audio ping: impulse heard in the guest playout, plus output latency.
3. Stats: `RTT / 2 + ptime / 2 + jitter buffer + output latency`, uncertainty ±`ptime / 2`.

Output latency is `(baseLatency + outputLatency) × 1000`, which matches the spec (the two values add). Input latency is loopback minus output when you have run **Calibrate I/O**, otherwise one audio block (~10 ms).

### Aligned recording

On punch-in the host broadcasts the timeline sample and the cue’s `performance.now()`. The guest has been rolling a ~30 s local buffer, so the control message cannot clip the top of the take. The capture window is shifted later by the one-way cue delay plus the guest’s input latency: the singer heard the music late, and the microphone heard them later still. Shifting the take earlier by that amount puts the vocal on the music they sang to.

An iPhone guest can see its own camera while the host sees nothing. That self-view is a local preview. Safari only sends it if the same track is on the video transceiver before the offer or answer is created, and if the video section says `sendrecv`. Attaching the camera after `setLocalDescription`, which is enough for Chrome and Samsung, leaves Safari on `recvonly`. The host’s offer lists H.264 and VP8, in that order, and does not lead with AV1. Opus SDP edits do not touch the video sections.

The WAV (16-bit) uploads on an ordered data channel in 16 KB chunks. If that channel is not open, the same bytes go through `/api/takes` and the server relays them to the host. The host drops the latent guide clip that shares the take id and places the aligned clip at the record-start sample, nudging it if the rolling buffer started late. A silent file is called out instead of being treated as a good take. The dock shows the media path, round trip, jitter, loss, jitter buffer, clock RTT, the live monitor estimate, and device input/output.

### Jam mode

Jam mode delays only the host’s local monitor (a `DelayNode` in front of the speakers, not in the cue). Remote audio is delayed by `max(0, jamDelay − measured one-way)` so the host hears the backing and the artist together, the way JamKazam and SonoBus do. Recordings stay on the absolute timeline. The artist’s cue is not delayed.

## Architecture

```
browser (Vite, React)
  AudioEngine  — interactive AudioContext, strips, transport, worklets
  SessionClient — mesh RTCPeerConnection, clock, takes, PCM
        │  /ws and /api
        ▼
signaling server (Node, ws) — rooms, waiting room, relay
```

Transceiver order is fixed: music audio, talkback audio, camera, screen. The lower peer id creates the offer and the `clock`, `takes`, and `pcm` data channels. The higher id answers. A failed connection restarts ICE.

Mesh, not an SFU. An SFU (mediasoup, LiveKit, and the like) adds a hop and another jitter buffer, which fights the latency goal. The cap is **6 admitted people** in one room. Past that, an SFU is the right scale path; it is not wired up.

Signaling messages: `hello` (create, join, resume), roster, `admit` / `reject` / `remove`, `signal`, `chat`, `presence`, `reaction`, `force-mute`, `transport`, `transport-request`, `project`, `project-asset`, and `clock`. Session codes are 6 unambiguous characters. An empty room expires after 15 minutes. Resume replaces the previous socket without dropping the participant.

The host is the clock for the arrangement. Play, stop, and locate on either side are scheduled against the shared clock so both playheads hit the same sample together. The host sends the arrangement and its audio; the guest plays that locally and mutes the delayed cue mix so the backing is not heard twice. Record stays with the host. A guest take that was sung against the local backing is placed with no extra network shift. Popping the session out opens a real window that shares the same session, so mute, camera, chat, admit, and copy invite keep working.

Health: `GET /api/health`. ICE config: `GET /api/ice`. While a room is open, each browser posts a compact WebRTC snapshot to `POST /api/diag/SESSION` every few seconds, and `GET /api/diag/SESSION` returns the last 200 (peer states, candidate types, offer count, selected pair, error text, user agent). The server also records create, join, leave, and evict, and a reloaded host records why it rejoined instead of minting a new code. Those entries are memory-only and disappear with the room. They do not include media or TURN secrets. In production the same process serves `dist/` and upgrades `/ws`. The browser opens that socket with `wss` when the page is `https`, and invite links use `location.origin`.

## Limits

- The live path cannot be zero. Device output on this machine was already 40 ms before the network.
- Opus in the browser does not go below 10 ms frames.
- The clock assumes a symmetric path. The minimum-RTT sample is the best estimate we keep, not a hardware timestamp.
- Loopback calibration needs a cable or a speaker-to-mic path. On headphones it reads near zero, and the input estimate falls back to one block.
- Two `getUserMedia` modes on one device (processed talkback and unprocessed music) can fail. The session notes it and keeps the performance mic.
- Chrome sometimes omits the jitter-buffer stat. The dock shows “—” and the estimate uses 0 ms of buffer.
- Mesh uplink grows with each person. Six is the cap. Someone who drops and comes back within 10 minutes reclaims their seat and is not counted twice.
- No account system on the signaling server. Anyone with the code can knock; the host still has to admit them.
- No VST/AU, no hardware MIDI, no tempo map. Inserts are the built-in EQ, compressor, delay, and reverb.
- IndexedDB quota bounds saved projects. Recording turns the loop off so the take stays linear. Session-mode MIDI repeats on a timer rather than the sample clock.
- Picture-in-picture pop-out is Chromium only.
- Talkback echo cancellation fails if the performance mix is coming out of speakers. Use headphones.
