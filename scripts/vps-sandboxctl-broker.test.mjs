import { describe, expect, it } from 'vitest';
import { parseBrokerRequest } from './vps-sandboxctl-broker.mjs';

describe('rootless runtime broker request validation', () => {
  it.each(['preflight', 'info', 'smoke'])('accepts the fixed %s operation', (operation) => {
    expect(parseBrokerRequest(JSON.stringify({ operation }))).toBe(operation);
  });

  it('rejects arbitrary operations', () => {
    expect(() => parseBrokerRequest('{"operation":"shell"}')).toThrow('Unsupported');
  });

  it('rejects extra request properties', () => {
    expect(() => parseBrokerRequest('{"operation":"smoke","command":"id"}')).toThrow('Unsupported');
  });

  it('rejects arrays, malformed JSON and oversized requests', () => {
    expect(() => parseBrokerRequest('[]')).toThrow('object');
    expect(() => parseBrokerRequest('{')).toThrow('valid JSON');
    expect(() => parseBrokerRequest(' '.repeat(257))).toThrow('too large');
  });
});
