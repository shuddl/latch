import { describe } from 'vitest';
import { InMemoryStore } from './memory';
import { runStoreContract } from './contract';

describe('InMemoryStore', () => {
  runStoreContract(() => new InMemoryStore());
});
