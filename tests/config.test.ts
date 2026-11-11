import { describe, expect, it } from 'vitest';
import { DEFAULT_WS_PORT, readWsPort } from '../src/config.js';

describe('readWsPort', () => {
  it('defaults to the fleet-shared concentrator port', () => {
    expect(DEFAULT_WS_PORT).toBe(37_149);
    expect(readWsPort({})).toBe(37_149);
  });

  it('honours BAND_WS_PORT', () => {
    expect(readWsPort({ BAND_WS_PORT: '40001' })).toBe(40_001);
  });
});
