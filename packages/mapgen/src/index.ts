// @latch/mapgen — build-time map generation + heal patching (docs/04). LLM-assisted
// behind @latch/shared's LlmClient; every output is Zod-validated and gated by the
// Verification Engine before it can reach production.
export * from './generate';
