const SENSITIVE_ASSIGNMENT = /(["']?)(password|passwd|pwd|api[_-]?key|x-api-key|client[_-]?secret|secret|access[_-]?token|refresh[_-]?token)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi;

export function redactSensitiveText(value) {
  return String(value)
    .replace(/(authorization\s*:\s*)(Basic|Bearer)\s+[^\s,;"']+/gi, '$1$2 [REDACTED]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, (match, quote, key, separator, rawValue) => {
      const valueQuote = rawValue[0] === '"' || rawValue[0] === "'" ? rawValue[0] : '';
      return quote + key + quote + separator + valueQuote + '[REDACTED]' + valueQuote;
    })
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS_KEY]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
}

export function redactSensitiveStreamLine(line) {
  return redactSensitiveText(line);
}
