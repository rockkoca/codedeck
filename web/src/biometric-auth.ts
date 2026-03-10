/**
 * Biometric authentication for Capacitor apps.
 * Protects JWT storage with Face ID / Touch ID / fingerprint.
 * Falls back gracefully on web (no-op).
 */
import { Capacitor } from '@capacitor/core';

const AUTH_KEY = 'deck_auth';

/** Store API key securely — biometric-protected on native, localStorage on web */
export async function storeAuthKey(apiKey: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    localStorage.setItem(AUTH_KEY, apiKey);
    return;
  }
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
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
  if (!Capacitor.isNativePlatform()) {
    return localStorage.getItem(AUTH_KEY);
  }
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');

    // Check availability first
    const avail = await BiometricAuth.checkBiometry();
    if (!avail.isAvailable) {
      return localStorage.getItem(AUTH_KEY);
    }

    // Authenticate before retrieving
    await BiometricAuth.verify({
      reason: 'Authenticate to access Remote Chat CLI',
      title: 'Remote Chat CLI',
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
  if (!Capacitor.isNativePlatform()) return;
  try {
    const { BiometricAuth } = await import('@aparajita/capacitor-biometric-auth');
    await BiometricAuth.deleteCredentials({
      username: 'deck_user',
      server: 'codedeck',
    });
  } catch {
    // ignore
  }
}
