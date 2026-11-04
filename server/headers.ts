/**
 * Document isolation for SharedArrayBuffer.
 *
 * `credentialless` lets no-cors fonts, images, and audio load without a
 * Cross-Origin-Resource-Policy header. `require-corp` would block Google
 * fonts and any Hugging Face or jsDelivr response that omits CORP.
 * Same-origin scripts are unaffected. WebRTC and TURN are not subresources.
 * Safari ignores `credentialless`, so `crossOriginIsolated` stays false there
 * and the audio thread stays single-threaded.
 */
export function isolationHeaders(): Record<string, string> {
  return {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'credentialless',
  }
}

export function withIsolation(headers: Record<string, string>): Record<string, string> {
  return { ...headers, ...isolationHeaders() }
}
