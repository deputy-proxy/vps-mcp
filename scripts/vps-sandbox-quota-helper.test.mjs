import {describe, expect, it} from 'vitest';
import {isMountpoint} from './vps-sandbox-quota-helper.mjs';

describe('isMountpoint', () => {
  it('returns true when mountpoint exits successfully', () => {
    const execute = () => {};
    expect(isMountpoint('/tmp/example', execute)).toBe(true);
  });

  it('treats util-linux exit code 32 as not mounted', () => {
    const execute = () => {
      const error = new Error('not a mountpoint');
      error.status = 32;
      throw error;
    };
    expect(isMountpoint('/tmp/example', execute)).toBe(false);
  });

  it('propagates unexpected command failures', () => {
    const execute = () => {
      const error = new Error('permission denied');
      error.status = 1;
      throw error;
    };
    expect(() => isMountpoint('/tmp/example', execute)).toThrow('permission denied');
  });
});
