import { describe, expect, it } from 'vitest';
import { passesCsrfCheck } from './csrf';

const req = (method: string, headers: Record<string, string>) =>
  new Request('http://app.stockos.test/api/proxy/users', {
    method,
    headers: { host: 'app.stockos.test', ...headers },
  });

describe('passesCsrfCheck', () => {
  it('allows safe methods without the header', () => {
    expect(passesCsrfCheck(req('GET', {}))).toBe(true);
  });

  it('requires the custom header on state-changing requests', () => {
    expect(passesCsrfCheck(req('POST', {}))).toBe(false);
    expect(passesCsrfCheck(req('DELETE', { 'x-stockos-csrf': '0' }))).toBe(false);
    expect(passesCsrfCheck(req('POST', { 'x-stockos-csrf': '1' }))).toBe(true);
  });

  it('rejects foreign or malformed origins', () => {
    expect(passesCsrfCheck(req('POST', { 'x-stockos-csrf': '1', origin: 'https://evil.example' }))).toBe(
      false,
    );
    expect(passesCsrfCheck(req('POST', { 'x-stockos-csrf': '1', origin: 'not a url' }))).toBe(false);
    expect(passesCsrfCheck(req('POST', { 'x-stockos-csrf': '1', origin: 'http://app.stockos.test' }))).toBe(
      true,
    );
  });
});
