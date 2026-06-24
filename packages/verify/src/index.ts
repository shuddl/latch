// @latch/verify — golden synthesis + the Proof (the moat). M1.4 (docs/07).
// The Verification Engine, not the model, is the gate: a map is `certified` only when
// `certify()` returns `passed: true` at the benchmark bar.

export * from './types';
export * from './oracle';
export * from './engine';
export { buildCorpus214 } from './corpus/214';
export { buildCorpus990 } from './corpus/990';
export { buildCorpus204 } from './corpus/204';
export { buildCorpus210 } from './corpus/210';
export { buildCorpus211 } from './corpus/211';
