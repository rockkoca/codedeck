/**
 * Biometric authentication for Capacitor apps.
 * Protects JWT storage with Face ID / Touch ID / fingerprint.
 * Falls back gracefully on web (no-op).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isNative = (): boolean => typeof (globalThis as any).Capacitor?.isNativePlatform === 'function' && (globalThis as any).Capacitor.isNativePlatform();

const AUTH_KEY = 'deck_auth';

/** Store API key securely — biometric-protected on native, localStorage on web */
export async function storeAuthKey(apiKey: string): Promise<void> {
  if (!isNative()) {
    localStorage.setItem(AUTH_KEY, apiKey);
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth') as any;
    await BiometricAuth.setCredentials({
      username: 'deck_user',
      password: apiKey,
      server: 'codedeck',
    });
  } catch {
    // Biometric not available — fall back to localStorage
    localStorage.setItem(AUTH_KEY, apiKey);
  }
}

/** Retrieve API key — prompts biometric on native */
export async function getAuthKey(): Promise<string | null> {
  if (!isNative()) {
    return localStorage.getItem(AUTH_KEY);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth') as any;

    // Check availability first
    const avail = await BiometricAuth.checkBiometry();
    if (!avail.isAvailable) {
      return localStorage.getItem(AUTH_KEY);
    }

    // Authenticate before retrieving
    await BiometricAuth.verify({
      reason: 'Authenticate to access CodeDeck',
      title: 'CodeDeck',
      negativeButtonText: 'Use Passcode',
    });

    const creds = await BiometricAuth.getCredentials({
      username: 'deck_user',
      server: 'codedeck',
    });
    return creds.password ?? null;
  } catch {
    return localStorage.getItem(AUTH_KEY);
  }
}

/** Clear stored auth key */
export async function clearAuthKey(): Promise<void> {
  localStorage.removeItem(AUTH_KEY);
  if (!isNative()) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth') as any;
    await BiometricAuth.deleteCredentials({
      username: 'deck_user',
      server: 'codedeck',
    });
  } catch {
    // ignore
  }
}
