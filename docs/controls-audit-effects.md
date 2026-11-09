# Effect, mixer, and transport controls

Scope is every effect plugin, the mixer (volume, pan, sends, master), and transport tempo.
Sampler, the library instrument, synths, Beat Machine, Scaler, and Auto-Tune are a separate audit.
Parameter ids are unchanged, so saved presets still load. Stepped knobs print the value the DSP uses.

Counts: **187 ok**, **81 fixed**, **4 removed**, **16 unverified**.

| Control | Label | Function | Status | Test |
| --- | --- | --- | --- | --- |
| EQ / Clean / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Clean / hp | HP | 20–1000 Hz, default 20 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Clean / lp | LP | 1000–20000 Hz, default 20000 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Clean / lowF | Low | 40–800 Hz, default 180 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Clean / lowG | Low | -18–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Clean / lowQ | Q | 0.2–8, default 0.7 | ok | src/test/effect-controls.test.ts |
| EQ / Clean / midF | Mid | 200–8000 Hz, default 1500 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Clean / midG | Mid | -18–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Clean / midQ | Q | 0.2–8, default 1 | ok | src/test/effect-controls.test.ts |
| EQ / Clean / highF | High | 1000–16000 Hz, default 8000 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Clean / highG | High | -18–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Clean / highQ | Q | 0.2–8, default 0.7 | ok | src/test/effect-controls.test.ts |
| EQ / Passive / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Passive / pLow | Low freq | 0–3, default 60 Hz | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pBoost | Low boost | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pAtten | Low cut | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pHigh | High freq | 0–6, default 10 kHz | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pAir | Air | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pWidth | Bandwidth | 0–1, default 50% | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pCut | High cut | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| EQ / Passive / pCutF | Cut freq | 0–2, default 10 kHz | fixed | src/test/effect-controls.test.ts |
| EQ / Pre / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Pre / preHp | HP | 0–4, default Off | fixed | src/test/effect-controls.test.ts |
| EQ / Pre / preLow | Low freq | 0–3, default 110 Hz | fixed | src/test/effect-controls.test.ts |
| EQ / Pre / preLowG | Low | -16–16 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Pre / preMid | Mid freq | 0–5, default 1.6 kHz | fixed | src/test/effect-controls.test.ts |
| EQ / Pre / preMidG | Mid | -18–18 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Pre / preHigh | High freq | 0–1, default 10 kHz | fixed | src/test/effect-controls.test.ts |
| EQ / Pre / preHighG | High | -16–16 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Pre / preDrive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| EQ / Channel / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Channel / curve | Narrow | 0–1, default 0 | fixed | src/test/effect-controls.test.ts |
| EQ / Channel / lfF | LF freq | 0–3, default 110 Hz | fixed | src/test/effect-controls.test.ts |
| EQ / Channel / lfG | LF | -15–15 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Channel / lmfF | LMF freq | 0–3, default 400 Hz | fixed | src/test/effect-controls.test.ts |
| EQ / Channel / lmfG | LMF | -15–15 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Channel / hmfF | HMF freq | 0–3, default 3 kHz | fixed | src/test/effect-controls.test.ts |
| EQ / Channel / hmfG | HMF | -15–15 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Channel / hfF | HF freq | 0–3, default 12 kHz | fixed | src/test/effect-controls.test.ts |
| EQ / Channel / hfG | HF | -15–15 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Tilt / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Tilt / tiltF | Freq | 0–10, default 800 Hz | fixed | src/test/effect-controls.test.ts |
| EQ / Tilt / tiltG | Gain | -12–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Focus / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Focus / f0 | Low | 40–500 Hz, default 120 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Focus / g0 | Low | -18–18 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Focus / q0 | Q | 0.2–12, default 0.7 | ok | src/test/effect-controls.test.ts |
| EQ / Focus / f1 | Mid | 200–8000 Hz, default 1500 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Focus / g1 | Mid | -18–18 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Focus / q1 | Q | 0.2–12, default 1 | ok | src/test/effect-controls.test.ts |
| EQ / Focus / f2 | High | 1000–16000 Hz, default 8000 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Focus / g2 | High | -18–18 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Focus / q2 | Q | 0.2–12, default 0.7 | ok | src/test/effect-controls.test.ts |
| EQ / Focus / dynamic | Dynamic | 0–1, default 0 | fixed | src/test/effect-controls.test.ts |
| EQ / Focus / focusThresh | Thresh | -48–0 dB, default -18 dB | ok | src/test/effect-controls.test.ts |
| EQ / Focus / linear | Linear | 0–1, default 0 | fixed | src/test/effect-controls.test.ts |
| EQ / Linear / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Linear / phase | Linear phase | 0–1, default 1 | fixed | src/test/effect-controls.test.ts |
| EQ / Linear / hp | HP | 20–1000 Hz, default 20 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Linear / lp | LP | 1000–20000 Hz, default 20000 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Linear / lowG | Low | -18–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Linear / midF | Mid | 200–8000 Hz, default 1500 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Linear / midG | Mid | -18–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Linear / midQ | Q | 0.2–8, default 1 | ok | src/test/effect-controls.test.ts |
| EQ / Linear / highG | High | -18–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Dynamic / kind | Kind | Selects Clean, Passive, Pre, Channel, Tilt, Focus, Linear, Dynamic | ok | src/test/effect-controls.test.ts |
| EQ / Dynamic / dynF | Freq | 80–12000 Hz, default 3000 Hz | ok | src/test/effect-controls.test.ts |
| EQ / Dynamic / dynQ | Q | 0.4–6, default 1.2 | unverified | not asserted |
| EQ / Dynamic / dynThresh | Thresh | -48–0 dB, default -24 dB | ok | src/test/effect-controls.test.ts |
| EQ / Dynamic / dynG | Gain | -12–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| EQ / Dynamic / dynA | Attack | 1–40 ms, default 10 ms | ok | src/test/effect-controls.test.ts |
| EQ / Dynamic / dynR | Release | 10–300 ms, default 80 ms | unverified | not asserted |
| Comp / VCA / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / VCA / threshold | Thresh | -60–0 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / VCA / ratio | Ratio | 1–20 :1, default 1 :1 | ok | src/test/effect-controls.test.ts |
| Comp / VCA / attack | Attack | 0.1–80 ms, default 10 ms | ok | src/test/effect-controls.test.ts |
| Comp / VCA / release | Release | 5–400 ms, default 120 ms | ok | src/test/effect-controls.test.ts |
| Comp / VCA / knee | Knee | 0–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / VCA / makeup | Makeup | 0–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / VCA / mix | Mix | 0–1, default 100% | fixed | src/test/effect-controls.test.ts |
| Comp / FET / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / FET / fetIn | Input | -24–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / FET / fetOut | Output | -24–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / FET / fetRatio | Ratio | 0–4, default 4:1 | fixed | src/test/effect-controls.test.ts |
| Comp / FET / fetAtk | Attack | 0.02–0.8 ms, default 0.2 ms | ok | src/test/effect-controls.test.ts |
| Comp / FET / fetRel | Release | 50–1100 ms, default 300 ms | ok | src/test/effect-controls.test.ts |
| Comp / Opto / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / Opto / optoPeak | Peak reduction | 0–1, default 35% | fixed | src/test/effect-controls.test.ts |
| Comp / Opto / optoGain | Gain | 0–24 dB, default 6 dB | ok | src/test/effect-controls.test.ts |
| Comp / Bus / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / Bus / busThresh | Thresh | -40–0 dB, default -8 dB | ok | src/test/effect-controls.test.ts |
| Comp / Bus / busRatio | Ratio | 0–2, default 4:1 | fixed | src/test/effect-controls.test.ts |
| Comp / Bus / busAtk | Attack | 0–5, default 1 ms | fixed | src/test/effect-controls.test.ts |
| Comp / Bus / busRel | Release | 0–4, default Auto | fixed | src/test/effect-controls.test.ts |
| Comp / Bus / hpf | SC HPF | 20–300 Hz, default 80 Hz | ok | src/test/effect-controls.test.ts |
| Comp / Bus / busMakeup | Makeup | 0–18 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / Vari-mu / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / Vari-mu / variTime | Time | 0–5, default 0.2 / 800 ms | fixed | src/test/effect-controls.test.ts |
| Comp / Vari-mu / variIn | Input | -12–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / Vari-mu / variOut | Output | -12–12 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / Vari-mu / variColor | Color | 0–1, default 0.35 | ok | src/test/effect-controls.test.ts |
| Comp / Glue / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / Glue / threshold | Thresh | -60–0 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / Glue / ratio | Ratio | 1–20 :1, default 1 :1 | ok | src/test/effect-controls.test.ts |
| Comp / Glue / attack | Attack | 0.1–80 ms, default 10 ms | ok | src/test/effect-controls.test.ts |
| Comp / Glue / release | Release | 5–400 ms, default 120 ms | ok | src/test/effect-controls.test.ts |
| Comp / Glue / releaseMode | Rel mode | 0–2, default Use release | fixed | src/test/effect-controls.test.ts |
| Comp / Glue / makeup | Makeup | 0–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / Glue / mix | Mix | 0–1, default 100% | fixed | src/test/effect-controls.test.ts |
| Comp / Multiband / kind | Kind | Selects VCA, FET, Opto, Bus, Vari-mu, Glue, Multiband | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / bands | Bands | 3–5, default 4 | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / x1 | X1 | 40–400 Hz, default 120 Hz | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / x2 | X2 | 150–1500 Hz, default 500 Hz | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / x3 | X3 | 800–6000 Hz, default 2000 Hz | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / x4 | X4 | 2000–12000 Hz, default 6000 Hz | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / threshold | Thresh | -60–0 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / ratio | Ratio | 1–20 :1, default 1 :1 | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / attack | Attack | 0.1–80 ms, default 10 ms | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / release | Release | 5–400 ms, default 120 ms | ok | src/test/effect-controls.test.ts |
| Comp / Multiband / makeup | Makeup | 0–24 dB, default 0 dB | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / kind | Kind | Selects Both, De-ess, Gate | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / freq | Freq | 3000–12000 Hz, default 6500 Hz | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / threshold | Thresh | -50–0 dB, default -18 dB | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / amount | Amount | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / gate | Gate | -80–0 dB, default -80 dB | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / gateRatio | Ratio | 1–20 :1, default 1 :1 | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Both / gateAtk | Attack | 0.1–40 ms, default 5 ms | unverified | not asserted |
| Vocal Clean / Both / gateRel | Release | 5–400 ms, default 80 ms | unverified | not asserted |
| Vocal Clean / Both / hold | Hold | 0–200 ms, default 20 ms | unverified | not asserted |
| Vocal Clean / Both / range | Range | 0–80 dB, default 40 dB | ok | src/test/effect-controls.test.ts |
| Vocal Clean / De-ess / kind | Kind | Selects Both, De-ess, Gate | ok | src/test/effect-controls.test.ts |
| Vocal Clean / De-ess / freq | Freq | 3000–12000 Hz, default 6500 Hz | ok | src/test/effect-controls.test.ts |
| Vocal Clean / De-ess / threshold | Thresh | -50–0 dB, default -18 dB | ok | src/test/effect-controls.test.ts |
| Vocal Clean / De-ess / amount | Amount | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Gate / kind | Kind | Selects Both, De-ess, Gate | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Gate / gate | Gate | -80–0 dB, default -80 dB | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Gate / gateRatio | Ratio | 1–20 :1, default 1 :1 | ok | src/test/effect-controls.test.ts |
| Vocal Clean / Gate / gateAtk | Attack | 0.1–40 ms, default 5 ms | unverified | not asserted |
| Vocal Clean / Gate / gateRel | Release | 5–400 ms, default 80 ms | unverified | not asserted |
| Vocal Clean / Gate / hold | Hold | 0–200 ms, default 20 ms | unverified | not asserted |
| Vocal Clean / Gate / range | Range | 0–80 dB, default 40 dB | ok | src/test/effect-controls.test.ts |
| Sat / Soft / kind | Kind | Selects Soft, Tape, Sum, Oxide, Clip, Amp | ok | src/test/effect-controls.test.ts |
| Sat / Soft / drive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Soft / tone | Tone | 800–12000 Hz, default 8000 Hz | ok | src/test/effect-controls.test.ts |
| Sat / Soft / mix | Mix | 0–1, default 100% | fixed | src/test/effect-controls.test.ts |
| Sat / Tape / kind | Kind | Selects Soft, Tape, Sum, Oxide, Clip, Amp | ok | src/test/effect-controls.test.ts |
| Sat / Tape / drive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Tape / speed | Speed | 0–2, default 15 ips | fixed | src/test/effect-controls.test.ts |
| Sat / Tape / bias | Bias | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Sat / Tape / wow | Wow | 0–1, default 0.15 | ok | src/test/effect-controls.test.ts |
| Sat / Tape / bump | Bump | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Sat / Tape / hiss | Hiss | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Sum / kind | Kind | Selects Soft, Tape, Sum, Oxide, Clip, Amp | ok | src/test/effect-controls.test.ts |
| Sat / Sum / drive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Sum / tube | Tube | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Oxide / kind | Kind | Selects Soft, Tape, Sum, Oxide, Clip, Amp | ok | src/test/effect-controls.test.ts |
| Sat / Oxide / drive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Oxide / color | Tube | 0–1, default 0 | fixed | src/test/effect-controls.test.ts |
| Sat / Oxide / mix | Mix | 0–1, default 100% | fixed | src/test/effect-controls.test.ts |
| Sat / Clip / kind | Kind | Selects Soft, Tape, Sum, Oxide, Clip, Amp | ok | src/test/effect-controls.test.ts |
| Sat / Clip / drive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Sat / Clip / clipMode | Hard | 0–1, default 0 | fixed | src/test/effect-controls.test.ts |
| Sat / Clip / ceiling | Ceiling | -6–0 dB, default -0.3 dB | ok | src/test/effect-controls.test.ts |
| Sat / Amp / kind | Kind | Selects Soft, Tape, Sum, Oxide, Clip, Amp | ok | src/test/effect-controls.test.ts |
| Sat / Amp / gain | Gain | 0–1, default 0.35 | ok | src/test/effect-controls.test.ts |
| Sat / Amp / bass | Bass | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| Sat / Amp / mid | Mid | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| Sat / Amp / treble | Treble | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| Sat / Amp / presence | Presence | 0–1, default 0 dB | fixed | src/test/effect-controls.test.ts |
| Sat / Amp / master | Master | 0–1, default 0.65 | ok | src/test/effect-controls.test.ts |
| Sat / Amp / cab | Cab | 0–1, default 1 | ok | src/test/effect-controls.test.ts |
| Reverb / Algorithm / kind | Kind | Selects Algorithm, Plate, Hall, Space | ok | src/test/effect-controls.test.ts |
| Reverb / Algorithm / mode | Mode | 0–2, default Chamber | fixed | src/test/effect-controls.test.ts |
| Reverb / Algorithm / size | Size | 0.1–1, default 0.6 | ok | src/test/effect-controls.test.ts |
| Reverb / Algorithm / damp | Damp | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Reverb / Algorithm / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Reverb / Plate / kind | Kind | Selects Algorithm, Plate, Hall, Space | ok | src/test/effect-controls.test.ts |
| Reverb / Plate / size | Size | 0.1–1, default 0.6 | ok | src/test/effect-controls.test.ts |
| Reverb / Plate / decay | Decay | 0.2–0.96, default 0.7 | ok | src/test/effect-controls.test.ts |
| Reverb / Plate / damp | Damp | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Reverb / Plate / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Reverb / Hall / kind | Kind | Selects Algorithm, Plate, Hall, Space | ok | src/test/effect-controls.test.ts |
| Reverb / Hall / mode | Mode | 0–2, default Chamber | fixed | src/test/effect-controls.test.ts |
| Reverb / Hall / size | Size | 0.1–1, default 0.6 | ok | src/test/effect-controls.test.ts |
| Reverb / Hall / decay | Decay | 0.2–0.96, default 0.7 | ok | src/test/effect-controls.test.ts |
| Reverb / Hall / damp | Damp | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Reverb / Hall / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Reverb / Space / kind | Kind | Selects Algorithm, Plate, Hall, Space | ok | src/test/effect-controls.test.ts |
| Reverb / Space / ir | Space | 0–1, default Room | fixed | src/test/effect-controls.test.ts |
| Reverb / Space / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Delay / Studio / kind | Kind | Selects Studio, Echo, Bucket, Digital | ok | src/test/effect-controls.test.ts |
| Delay / Studio / sync | Sync | 0–1, default 1 | ok | src/test/effect-controls.test.ts |
| Delay / Studio / division | Div | 0.125–1 beat, default 0.38 beat | ok | src/test/effect-controls.test.ts |
| Delay / Studio / time | Time | 1–1800 ms, default 250 ms | fixed | src/test/effect-controls.test.ts |
| Delay / Studio / feedback | Feedback | 0–0.95, default 0.35 | ok | src/test/effect-controls.test.ts |
| Delay / Studio / pingpong | Ping | 0–1, default 1 | ok | src/test/effect-controls.test.ts |
| Delay / Studio / filter | Filter | 400–12000 Hz, default 5000 Hz | ok | src/test/effect-controls.test.ts |
| Delay / Studio / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Delay / Echo / kind | Kind | Selects Studio, Echo, Bucket, Digital | ok | src/test/effect-controls.test.ts |
| Delay / Echo / time | Time | 1–1800 ms, default 250 ms | fixed | src/test/effect-controls.test.ts |
| Delay / Echo / feedback | Feedback | 0–0.95, default 0.35 | ok | src/test/effect-controls.test.ts |
| Delay / Echo / wow | Wow | 0–1, default 0.25 | ok | src/test/effect-controls.test.ts |
| Delay / Echo / drive | Drive | 0–1, default 0 | ok | src/test/effect-controls.test.ts |
| Delay / Echo / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Delay / Bucket / kind | Kind | Selects Studio, Echo, Bucket, Digital | ok | src/test/effect-controls.test.ts |
| Delay / Bucket / time | Time | 1–1800 ms, default 250 ms | fixed | src/test/effect-controls.test.ts |
| Delay / Bucket / feedback | Feedback | 0–0.95, default 0.35 | ok | src/test/effect-controls.test.ts |
| Delay / Bucket / clock | Clock | 0–1, default 0.45 | ok | src/test/effect-controls.test.ts |
| Delay / Bucket / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Delay / Digital / kind | Kind | Selects Studio, Echo, Bucket, Digital | ok | src/test/effect-controls.test.ts |
| Delay / Digital / time | Time | 1–1800 ms, default 250 ms | fixed | src/test/effect-controls.test.ts |
| Delay / Digital / feedback | Feedback | 0–0.95, default 0.35 | ok | src/test/effect-controls.test.ts |
| Delay / Digital / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Chorus / kind | Kind | Selects Chorus, Double, Ensemble, Phase, Rotor, Shift | ok | src/test/effect-controls.test.ts |
| Mod / Chorus / rate | Rate | 0.02–4 Hz, default 0.4 Hz | ok | src/test/effect-controls.test.ts |
| Mod / Chorus / depth | Depth | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Mod / Chorus / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Double / kind | Kind | Selects Chorus, Double, Ensemble, Phase, Rotor, Shift | ok | src/test/effect-controls.test.ts |
| Mod / Double / width | Width | 0–1, default 0.5 | fixed | src/test/effect-controls.test.ts |
| Mod / Double / delay | Delay | 5–40 ms, default 18 ms | ok | src/test/effect-controls.test.ts |
| Mod / Double / depth | Depth | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Mod / Double / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Ensemble / kind | Kind | Selects Chorus, Double, Ensemble, Phase, Rotor, Shift | ok | src/test/effect-controls.test.ts |
| Mod / Ensemble / rate | Rate | 0.02–4 Hz, default 0.4 Hz | ok | src/test/effect-controls.test.ts |
| Mod / Ensemble / depth | Depth | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Mod / Ensemble / mode | Mode | 0–1, default Ensemble | fixed | src/test/effect-controls.test.ts |
| Mod / Ensemble / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Phase / kind | Kind | Selects Chorus, Double, Ensemble, Phase, Rotor, Shift | ok | src/test/effect-controls.test.ts |
| Mod / Phase / rate | Rate | 0.02–4 Hz, default 0.4 Hz | ok | src/test/effect-controls.test.ts |
| Mod / Phase / depth | Depth | 0–1, default 0.4 | ok | src/test/effect-controls.test.ts |
| Mod / Phase / feedback | Feedback | 0–0.9, default 0.4 | ok | src/test/effect-controls.test.ts |
| Mod / Phase / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Rotor / kind | Kind | Selects Chorus, Double, Ensemble, Phase, Rotor, Shift | ok | src/test/effect-controls.test.ts |
| Mod / Rotor / speed | Fast | 0–1, default 0 | fixed | src/test/effect-controls.test.ts |
| Mod / Rotor / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Shift / kind | Kind | Selects Chorus, Double, Ensemble, Phase, Rotor, Shift | ok | src/test/effect-controls.test.ts |
| Mod / Shift / semis | Semi | -12–12 st, default 0 st | ok | src/test/effect-controls.test.ts |
| Mod / Shift / harmony | Harm | -12–12 st, default 7 st | ok | src/test/effect-controls.test.ts |
| Mod / Shift / harmonyMix | Harm mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Mod / Shift / mix | Mix | 0–1, default 0% | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / kind | Kind | Selects Transparent, Brick, Loud | ok | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / threshold | Thresh | -24–0 dB, default 0 dB | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / release | Release | 5–300 ms, default 50 ms | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / ceiling | Ceiling | -6–0 dB, default -0.1 dB | ok | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / width | Width | 0–2, default 1 | ok | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / bass | Mono | 40–300 Hz, default 120 Hz | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / bits | Bits | 16–24, default 24 | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Transparent / shape | Shape | 0–2, default Flat | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Brick / kind | Kind | Selects Transparent, Brick, Loud | ok | src/test/effect-controls.test.ts |
| Master Limiter / Brick / ceiling | Ceiling | -6–0 dB, default -0.1 dB | ok | src/test/effect-controls.test.ts |
| Master Limiter / Brick / release | Release | 5–300 ms, default 50 ms | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Brick / lookahead | Look | 1–10 ms, default 5 ms | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Brick / releaseMode | Rel mode | 0–2, default Use release | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Brick / bits | Bits | 16–24, default 24 | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Brick / shape | Shape | 0–2, default Flat | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Loud / kind | Kind | Selects Transparent, Brick, Loud | ok | src/test/effect-controls.test.ts |
| Master Limiter / Loud / target | Target | -24–-6 LU, default -14 LU | ok | src/test/effect-controls.test.ts |
| Master Limiter / Loud / ceiling | Ceiling | -6–0 dB, default -0.1 dB | ok | src/test/effect-controls.test.ts |
| Master Limiter / Loud / release | Release | 5–300 ms, default 50 ms | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Loud / lookahead | Look | 1–10 ms, default 5 ms | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Loud / width | Width | 0–2, default 1 | ok | src/test/effect-controls.test.ts |
| Master Limiter / Loud / bass | Mono | 40–300 Hz, default 120 Hz | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Loud / low | Low | 0–2, default 1 | unverified | not asserted |
| Master Limiter / Loud / high | High | 0–2, default 1 | unverified | not asserted |
| Master Limiter / Loud / bits | Bits | 16–24, default 24 | fixed | src/test/effect-controls.test.ts |
| Master Limiter / Loud / shape | Shape | 0–2, default Flat | fixed | src/test/effect-controls.test.ts |
| Amp / model | Amp model | Selects the amp voicing. | ok | src/test/effect-controls.test.ts |
| Amp / bright | Bright | High shelf ahead of the amp. | ok | src/test/effect-controls.test.ts |
| Amp / mute | Mute | Silences the amp after the tuner has read the input. | ok | src/test/effect-controls.test.ts |
| Amp / pedal / comp release | Release | Comp pedal release. Was unwired. | fixed | src/test/effect-controls.test.ts |
| Amp / pedal / sub freq | Freq | Sub pedal frequency. Was a fixed 120 Hz. | fixed | src/test/effect-controls.test.ts |
| Amp / cab A | Cabinet A | Cabinet impulse for the left blend. | unverified | not asserted |
| Amp / cab B | Cabinet B | Cabinet impulse for the right blend. | unverified | not asserted |
| Amp / mic | Mic | Microphone used to build the cabinet impulse. | unverified | not asserted |
| Amp / axis | On axis | Moves the mic off the cabinet axis. | unverified | not asserted |
| Amp / blend | Blend | Crossfades cabinet A and cabinet B. | unverified | not asserted |
| Amp / distance | Distance | Mic distance on the cabinet impulse. | unverified | not asserted |
| Mixer / channel / volume | Volume | Linear gain 0–1.25, readout in dB. 0.5 is −6 dB. | ok | src/test/effect-controls.test.ts |
| Mixer / channel / pan | Pan | Constant-power pan, −1 left to +1 right. | ok | src/test/effect-controls.test.ts |
| Mixer / channel / send | Send level | Linear send gain 0–1 onto the bus. | ok | src/test/effect-controls.test.ts |
| Mixer / channel / pre | Before / After | Before ignores the fader. After follows it. | ok | src/test/effect-controls.test.ts |
| Mixer / master / volume | Master volume | Linear gain 0–1.25 on the mix, readout in dB. | ok | src/test/effect-controls.test.ts |
| Plugin / route / wet | Wet | 0 is the dry insert input. 1 is the processed signal. | ok | src/test/effect-controls.test.ts |
| Transport / tempo | Tempo | 30–300 BPM. Sets the musical clock and synced delay time. | ok | src/test/effect-controls.test.ts |
| Amp / pedal / tuner level | Level | Tuner pedal does not process audio. | removed | src/test/effect-controls.test.ts |
| Amp / pedal / tuner tone | Tone | Tuner pedal does not process audio. | removed | src/test/effect-controls.test.ts |
| Amp / pedal / octaver tone | Tone | Octave pedal interval is fixed. The extra tone knob did nothing. | removed | src/test/effect-controls.test.ts |
| Amp / pedal / loop tone | Tone | Loop pedal uses Mix, Rec, and Play. | removed | src/test/effect-controls.test.ts |
