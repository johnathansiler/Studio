/// <reference types="vite/client" />

interface DocumentPictureInPicture {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>
  readonly window?: Window | null
}

interface DevicePosture extends EventTarget {
  readonly type: 'continuous' | 'folded'
}

interface Navigator {
  devicePosture?: DevicePosture
}

interface Window {
  documentPictureInPicture?: DocumentPictureInPicture
}

interface AudioContext {
  setSinkId?(sinkId: string): Promise<void>
}

interface RTCRtpReceiver {
  playoutDelayHint?: number
  jitterBufferTarget?: number
}
