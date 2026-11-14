import './styles.css';
import { initNav, push, depth } from './nav';
import { homeScreen, consumeSharedFiles, listenForIncomingFiles } from './library';
import { isNative, setupBackButton } from './native';
import { toast } from './ui';

const root = document.getElementById('app')!;
initNav(root);
push(homeScreen());
consumeSharedFiles();
listenForIncomingFiles();
setupBackButton(() => depth() > 1);

// The native app ships all files inside the APK, so the offline service worker is web-only.
if ('serviceWorker' in navigator && import.meta.env.PROD && !isNative) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('Update available — restart the app to use the new version', 5000);
        });
      });
    }).catch((e) => console.warn('SW registration failed', e));
  });
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
});
