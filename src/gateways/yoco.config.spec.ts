import {
  assertYocoConfigConsistency,
  detectYocoModeFromKeys,
  resolveYocoConfig,
} from './yoco.config';

describe('resolveYocoConfig', () => {
  it('detects Yoco test mode from matching test keys', () => {
    const resolved = resolveYocoConfig({
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: null,
    });

    expect(resolved.testMode).toBe(true);
  });

  it('detects Yoco live mode from matching live keys', () => {
    const resolved = resolveYocoConfig({
      yocoPublicKey: 'pk_live_public',
      yocoSecretKey: 'sk_live_secret',
      yocoTestMode: null,
    });

    expect(resolved.testMode).toBe(false);
  });

  it('throws when Yoco public and secret keys belong to different environments', () => {
    expect(() =>
      detectYocoModeFromKeys('pk_test_public', 'sk_live_secret'),
    ).toThrow(
      'Yoco public and secret keys must belong to the same environment',
    );
  });

  it('throws when explicit Yoco testMode conflicts with key environment', () => {
    const resolved = resolveYocoConfig({
      yocoPublicKey: 'pk_test_public',
      yocoSecretKey: 'sk_test_secret',
      yocoTestMode: false,
    });

    expect(() => assertYocoConfigConsistency(resolved)).toThrow(
      'Yoco keys do not match the selected testMode',
    );
  });
});
