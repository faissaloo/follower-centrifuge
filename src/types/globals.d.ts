/**
 * Compile-time globals injected by webpack's DefinePlugin.
 *
 * `__IU_EMBEDDED_DEEPSEEK_KEY__` is only non-empty for the local, gitignored
 * keyed build (`npm run build:local-key`); the tracked public build always
 * compiles it to an empty string. Vitest has no DefinePlugin, so every access
 * must be guarded with `typeof ... !== 'undefined'`.
 */
declare const __IU_EMBEDDED_DEEPSEEK_KEY__: string;
declare const __IU_EMBEDDED_TYPESAFE_KEY__: string;
