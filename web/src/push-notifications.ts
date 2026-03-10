/**
 * Push notification registration for Capacitor apps.
 * Registers for APNs (iOS) / FCM (Android) and sends token to CF Worker.
 */
import { Capacitor } from '@capacitor/core';

let pushSupported = false;

export async function initPushNotifications(
  apiKey: string,
  cfWorkerUrl: string,
): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  // Dynamic import to avoid bundling on web
  const { PushNotifications } = await import('@capacitor/push-notifications');

  const perms = await PushNotifications.checkPermissions();
  if (perms.receive !== 'granted') {
    const req = await PushNotifications.requestPermissions();
    if (req.receive !== 'granted') return;
  }

  pushSupported = true;
  await PushNotifications.register();

  PushNotifications.addListener('registration', async (token) => {
    await registerDeviceToken(token.value, apiKey, cfWorkerUrl);
  });

  PushNotifications.addListener('pushNotificationReceived', (notification) => {
    console.log('Push received:', notification);
  });

  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    console.log('Push action:', action);
    // Navigate based on action data (e.g., to specific session)
    const data = action.notification.data as Record<string, string> | undefined;
    if (data?.sessionName) {
      window.dispatchEvent(new CustomEvent('deck:navigate', { detail: { sessionName: data.sessionName } }));
    }
  });
}

async function registerDeviceToken(token: string, apiKey: string, cfWorkerUrl: string): Promise<void> {
  const platform = Capacitor.getPlatform(); // 'ios' | 'android'
  try {
    await fetch(`${cfWorkerUrl}/api/push/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, platform }),
    });
  } catch (err) {
    console.warn('Failed to register push token:', err);
  }
}

export function isPushSupported(): boolean {
  return pushSupported;
}
