

/**
 * One decoded zone through the sampler voice pool.
 * The pool is the Rust/WASM voice when that module is loaded, and the TypeScript voice otherwise.
 * Multi-sample notes, velocity, and round-robin stay on the TypeScript sampler.
 */

