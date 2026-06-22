// @latch/verify — golden synthesis + the Proof (the moat). M1.4 (docs/07).
// The Verification Engine, not the model, is the gate: a map is `certified` only when
// `certify()` returns `passed: true` at the benchmark bar.

export * from './types';
export * from './oracle';
export * from './engine';
export { buildCorpus214 } from './corpus/214';
