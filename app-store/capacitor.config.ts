import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.sangminbis9.skinstudio',
  appName: '마크 스킨 뚝딱',
  webDir: 'dist',
  // Ship the editor inside the app. Never point release builds at a remote site.
  ios: { contentInset: 'never', backgroundColor: '#eeede8' },
};

export default config;
