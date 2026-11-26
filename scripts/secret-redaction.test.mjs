import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from './secret-redaction.mjs';

describe('sensitive text redaction', () => {
  it('redacts common credential assignments and HTTP authorization headers', () => {
    const input = [
      'password=synthetic-password',
      'passwd=synthetic-passwd',
      'api_key=synthetic-api-key',
      'x-api-key: synthetic-header-key',
      'client_secret=synthetic-client-secret',
      'access_token=synthetic-access-token',
      'refresh_token=synthetic-refresh-token',
      'Authorization: Basic synthetic-basic',
      'Authorization: Bearer synthetic-bearer',
    ].join('\n');

    const result = redactSensitiveText(input);

    for (const secret of [
      'synthetic-password',
      'synthetic-passwd',
      'synthetic-api-key',
      'synthetic-header-key',
      'synthetic-client-secret',
      'synthetic-access-token',
      'synthetic-refresh-token',
      'synthetic-basic',
      'synthetic-bearer',
    ]) expect(result).not.toContain(secret);

    expect(result).toContain('password=[REDACTED]');
    expect(result).toContain('x-api-key: [REDACTED]');
    expect(result).toContain('Authorization: Basic [REDACTED]');
    expect(result).toContain('Authorization: Bearer [REDACTED]');
  });

  it('redacts quoted structured fields without breaking their surrounding syntax', () => {
    const input = '{"password":"synthetic-password","x-api-key":"synthetic-api-key","client_secret":"synthetic-secret"}';
    const result = redactSensitiveText(input);

    expect(result).toBe('{"password":"[REDACTED]","x-api-key":"[REDACTED]","client_secret":"[REDACTED]"}');
    expect(result).not.toContain('synthetic-');
  });

  it('retains existing token, AWS key and private-key redaction', () => {
    const result = redactSensitiveText([
      'ghp_' + 'a'.repeat(30),
      'AKIA1234567890ABCDEF',
      '-----BEGIN PRIVATE KEY-----',
      'synthetic-private-key',
      '-----END PRIVATE KEY-----',
    ].join('\n'));

    expect(result).toContain('[REDACTED_TOKEN]');
    expect(result).toContain('[REDACTED_AWS_KEY]');
    expect(result).toContain('[REDACTED_PRIVATE_KEY]');
    expect(result).not.toContain('synthetic-private-key');
  });
});
