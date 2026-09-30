import { PUBLIC_PROCEDURES } from '@waddlers/contracts';
import { describe, expect, it } from 'vitest';
import {
  allContractPaths,
  CLASSIFICATION,
  inputKeysByPath,
  SPACE_LIKE_KEY_JUSTIFICATIONS,
} from '../../test/procedure-classification';

describe('every contract procedure is explicitly classified (public | user | space)', () => {
  it('classifies the whole contract: no unclassified path and no stale entry', () => {
    expect(Object.keys(CLASSIFICATION).sort()).toEqual(allContractPaths());
  });

  it('the public classification equals PUBLIC_PROCEDURES', () => {
    const publicPaths = Object.entries(CLASSIFICATION)
      .filter(([, c]) => c === 'public')
      .map(([p]) => p)
      .sort();
    expect(publicPaths).toEqual([...PUBLIC_PROCEDURES].sort());
  });

  it('every procedure with a `spaceId` input is classified as space-scoped', () => {
    const keys = inputKeysByPath();
    for (const [path, names] of Object.entries(keys)) {
      if (names.includes('spaceId')) expect(CLASSIFICATION[path], path).toBe('space');
    }
  });

  it('a deep search of every input finds no space/position-looking key outside space-scoped procedures', () => {
    const offenders: string[] = [];
    for (const [path, names] of Object.entries(inputKeysByPath())) {
      if (CLASSIFICATION[path] === 'space') continue;
      const hit = names.filter((n) => /space|position/i.test(n));
      if (hit.length > 0 && !SPACE_LIKE_KEY_JUSTIFICATIONS[path]) {
        offenders.push(`${path}: ${hit.join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the deep key search sees nested keys (sanity)', () => {
    const keys = inputKeysByPath();
    expect(keys['positions.list']).toEqual(
      expect.arrayContaining(['spaceId', 'page', 'offset', 'limit']),
    );
    expect(keys['positions.setQuantity']).toEqual(
      expect.arrayContaining(['spaceId', 'positionId', 'quantity']),
    );
  });
});
