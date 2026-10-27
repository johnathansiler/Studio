/** Installed onnxruntime-web. Keep this equal to the package.json dependency. */
export const ORT_VERSION = '1.31.1'

/**
 * ONNX Runtime WASM and its glue.
 * Pinned jsDelivr release of onnxruntime-web. The app host does not serve these files.
 */
export const ORT_WASM_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`
