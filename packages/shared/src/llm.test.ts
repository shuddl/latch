import { describe, it, expect } from 'vitest';
import { parseJsonLoose } from './llm';

describe('parseJsonLoose', () => {
  it('parses a bare JSON object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips code fences', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('ignores leading and trailing prose', () => {
    expect(parseJsonLoose('Sure! Here you go:\n{"a":[1,2]}\nHope that helps.')).toEqual({ a: [1, 2] });
  });
  it('handles braces inside strings', () => {
    expect(parseJsonLoose('{"note":"a } b"}')).toEqual({ note: 'a } b' });
  });
  it('throws on non-JSON', () => {
    expect(() => parseJsonLoose('no json here')).toThrow();
  });
});
