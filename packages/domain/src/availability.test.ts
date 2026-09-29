import { describe, expect, it } from 'vitest';
import { isAvailable } from './availability';

describe('isAvailable', () => {
  it('treats null and undefined as unavailable', () => {
    expect(isAvailable(null)).toBe(false);
    expect(isAvailable(undefined)).toBe(false);
  });

  it('treats 0 and negative values as available', () => {
    expect(isAvailable(0)).toBe(true);
    expect(isAvailable(-21.4)).toBe(true);
    expect(isAvailable('0')).toBe(true);
  });
});
