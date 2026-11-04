/** The two setup actions that stay on screen. Opus, Ping, and Jam are not shown. */

export const SETUP_PLAIN = {
  hear: { label: 'Hear myself', detail: 'Sends your sound into the session.' },
  calibrate: { label: 'Fix delay', detail: 'Play the click near your mic so recordings line up.' },
} as const
