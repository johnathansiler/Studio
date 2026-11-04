# Handoff

Branch: `cursor/step-sequencer-plugin-a05f`

`tsc -p tsconfig.json --noEmit` passes. A full `vite build` was not run. The Playwright file `src/test/studio-nav.e2e.test.ts` was still running when this handoff was written; do not treat that run as a result.

## 1. Step Sequencer plugin replacing Beats

**Status: partial**

Done in code:

- Beats is no longer a top-level view. `preferArrangeView` maps a saved `beats` view to Arrange.
- New instrument insert `steps` (`createStepsPlugin` in `src/model/stepPlugin.ts`). Patterns live on `PluginInstance.steps` and save with the project.
- Adding it from a track’s insert list, or from Add Track, opens `StepSequencerPanel` (the old channel rack). Close clears it. Escape and browser Back use the same history mark as the piano and Beat Machine (`steps`).
- Playback schedules that plugin’s pattern through its track strip (`scheduleStepSequencers` in `src/audio/engine.ts`) and calls `markMidi` so the arrange MIDI light can blink.
- `adoptStepSequencers` runs from `normalizeProject`. A factory-untouched rack does not add a track. An edited rack or a placed pattern clip becomes a `Step Sequencer N` track, and arrangement pattern clips are retargeted to that track.
- The effect rack was treating `steps` as an audio insert and silencing the strip. `liveRack.ts` `owners()` now skips `pluginId === 'steps'`. This fix is in the tree and has not been re-tested.

Not verified after the silence fix: Play moving the track-header meter, the mixer meter, and the master meter, or the MIDI light blinking on steps.

## 2. Only three tabs: Collab, Arrange, Mix

**Status: done**

`VIEW_COPY` no longer includes Beats. Session stays behind `FEATURES.session` (false), so the bar is Collab, Arrange, Mix. Collab remains the first button.

## 3. Prominent left Add Track and a clearer menu

**Status: partial**

Done in code:

- The Arrange Add Track control sits at the top of the track-header column (left), with a matching spacer on the timeline so lanes stay aligned.
- Label is `Add Track`. CSS sets that button to 52px tall.
- One tap on a choice adds the track, selects it, and opens its editor. Choices: Instrument (Play keys), Step Sequencer (Program beats), Beat Machine (Pads), Audio / Vocal (Record mic). No second confirm dialog.
- Instrument opens the small keyboard. Step Sequencer opens its panel. Beat Machine opens pads. Audio is armed for the mic and selected, with no extra panel.

The phone-fit check saw the button at 47px before the 52px rule. That rule has not been re-measured.

## 4. Mixer is columns only

**Status: done**

`mixerFlow` always returns `columns`. `normalizeLayout` / `readLayout` rewrite a saved `rows` value to `columns`. The Rows and Columns buttons are gone from `WidthBar`. `MixerView` always uses vertical strips (`data-layout="columns"`), including at phone width, in a horizontally scrolling mixer.

## 5. Menu button on the left

**Status: done**

The Menu button is the first control in the top bar. Phone, fold, and landscape `order` put it first. It shows the icon and the word Menu, with a 40px minimum (44px on phone, 40px in landscape). The menu panel opens from the left on desktop. Landscape top-bar max height was raised from 32px to 44px so the button is not clipped. `phone-landscape.test.ts` now allows a top bar up to 48px.

## What was tested

Passed after these edits:

- `tsc --noEmit`
- Unit tests excluding `*.e2e.test.ts`: 783 passed, then the three failures below were addressed. A second pass of `channel-rack`, `mixer-adapt`, `fader-dominant`, and `narrow-mixer` passed.
- `editor-exclusive.test.ts` passed when run on its own (Beat Machine still opens from the new one-tap menu).
- `src/test/step-sequencer.test.ts` passed in the first unit batch (migration, insert, Beat Machine still reachable).

## Known failing or unverified tests

- `src/test/studio-nav.e2e.test.ts` timed out waiting for track and master meters. At that time the effect rack was still swallowing the Step Sequencer. The `owners()` skip is untested. The same file’s earlier assertions (exactly Collab, Arrange, Mix, and Menu on the left, >= 40px) had already run before the timeout.
- `src/test/phone-fit.test.ts` failed `addBox.height >= 48` with a measured 47px. CSS is now 52px and was not re-run. The step grid itself had already rendered inside the sequencer panel.
- `npm run build` was not run.
- `session-dock` e2e (three tabs, no Beats click) was not re-run.
- `beat-keyboard-open` e2e was updated for the one-tap Beat Machine choice and was not re-run.

## Next steps

1. Re-run `src/test/studio-nav.e2e.test.ts`. If meters stay near zero, confirm `LiveRack.owners()` omits `steps` and that a direct `playThrough` on the new track moves `engine.levels().tracks[id]` the way Keys does (Keys peaked around 0.09 while the sequencer track stayed at the analyser floor).
2. Re-run `src/test/phone-fit.test.ts` and confirm the Add Track control is at least 48px and still at the left of the header column.
3. Re-run `src/test/session-dock.test.ts` and `src/test/beat-keyboard-open.test.ts`.
4. Run `npm run build`.
5. If Play is proven, drop this handoff or fold the notes into the PR.
