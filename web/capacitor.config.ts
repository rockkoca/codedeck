import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.remotechatcli.app',
  appName: 'Remote Chat CLI',
  webDir: 'dist',
  server: {
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
      backgroundColor: '#1a1b1e',
      showSpinner: false,
    },
  },
  ios: {
    contentInset: 'automatic',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
