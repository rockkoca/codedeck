import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subSessionName, detectShells } from '../../src/daemon/subsession-manager.js';

describe('subSessionName()', () => {
  it('prefixes with deck_sub_', () => {
    expect(subSessionName('abc12345')).toBe('deck_sub_abc12345');
  });

  it('does not produce standard deck_ prefix', () => {
    // Must be distinguishable from normal sessions like deck_proj_brain
    const name = subSessionName('xyz');
    expect(name.startsWith('deck_sub_')).toBe(true);
    expect(name).not.toMatch(/deck_[^s]/);
  });
});

describe('detectShells()', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns an array', async () => {
    const shells = await detectShells();
    expect(Array.isArray(shells)).toBe(true);
  });

  it('includes SHELL env var when it exists', async () => {
    const original = process.env.SHELL;
    // Only test if SHELL is set and the binary actually exists (CI may not have it)
    if (original) {
      const shells = await detectShells();
      // SHELL should be first in list if it exists on disk
      const { existsSync } = await import('node:fs');
      if (existsSync(original)) {
        expect(shells[0]).toBe(original);
      }
    }
  });

  it('returns no duplicates', async () => {
    const shells = await detectShells();
    const unique = new Set(shells);
    expect(unique.size).toBe(shells.length);
  });

  it('all returned paths are absolute', async () => {
    const shells = await detectShells();
    for (const s of shells) {
      expect(s.startsWith('/')).toBe(true);
    }
  });
});
