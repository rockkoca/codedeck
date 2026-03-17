import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.codedeck',
  appName: 'CodeDeck',
  webDir: 'dist',
  server: {
    // hostname must match the passkey rpId (app.codedeck.org) so WebAuthn works in WKWebView.
    // Without this, the WebView origin is capacitor://localhost which doesn't match the rpId.
    hostname: 'app.codedeck.org',
    androidScheme: 'https',
    // During development, point to the Vite dev server for live reload.
    // Comment out for production builds.
    // url: 'http://localhost:5173',
    // cleartext: true,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#0f172a',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f172a',
    },
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#0f172a',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
