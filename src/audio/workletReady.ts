/** Load a worklet module. False when this browser has no AudioWorklet. */
export function loadWorklet(ctx: BaseAudioContext, url: string): Promise<boolean> {
  return Promise.resolve().then(() => {
    const add = ctx.audioWorklet?.addModule
    if (typeof add !== 'function' || typeof AudioWorkletNode !== 'function') return false
    return add.call(ctx.audioWorklet, url).then(() => true)
  }).catch(() => false)
}
