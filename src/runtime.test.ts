import { describe, expect, it } from 'vitest';
import { isRuntimeOperation } from './runtime.js';


describe('approved runtime operations', () => {
  it.each(['preflight', 'info', 'smoke'])('allows the fixed %s operation', (operation) => {
    expect(isRuntimeOperation(operation)).toBe(true);
  });

  it.each(['', 'shell', 'exec', 'podman', 'systemd-run', 'smoke; id', '../smoke'])('rejects unapproved operation %j', (operation) => {
    expect(isRuntimeOperation(operation)).toBe(false);
  });
});
