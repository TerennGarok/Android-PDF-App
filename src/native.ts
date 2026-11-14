// Bridges to the native Android app (Capacitor). In a plain browser these fall back to web APIs.
import { Capacitor, registerPlugin, PluginListenerHandle } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      res(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/** Save into the phone's Documents/PocketPDF folder. Returns a human-readable location. */
export async function nativeSave(blob: Blob, filename: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const data = await blobToBase64(blob);
  let name = filename;
  // avoid overwriting an existing file with the same name
  for (let i = 1; i < 100; i++) {
    try {
      await Filesystem.stat({ path: `PocketPDF/${name}`, directory: Directory.Documents });
      name = filename.replace(/(\.[^.]+)?$/, ` (${i})$1`);
    } catch {
      break;
    }
  }
  await Filesystem.writeFile({ path: `PocketPDF/${name}`, data, directory: Directory.Documents, recursive: true });
  return `Documents/PocketPDF/${name}`;
}

/** Open the Android share sheet (email, Drive, WhatsApp, print services, other PDF apps…). */
export async function nativeShare(blob: Blob, filename: string): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const data = await blobToBase64(blob);
  const res = await Filesystem.writeFile({ path: `share/${filename}`, data, directory: Directory.Cache, recursive: true });
  try {
    await Share.share({ title: filename, files: [res.uri], dialogTitle: 'Share ' + filename });
  } catch (e: any) {
    if (!/cancel/i.test(String(e?.message || e))) throw e;
  }
}

interface IncomingFile {
  path: string;
  name: string;
  mimeType?: string;
}
interface IncomingFilesPlugin {
  addListener(event: 'files', cb: (data: { files: IncomingFile[] }) => void): Promise<PluginListenerHandle>;
}
const IncomingFiles = registerPlugin<IncomingFilesPlugin>('IncomingFiles');

/** Files opened with / shared to the app from other Android apps. */
export function onIncomingFiles(cb: (files: File[]) => void) {
  if (!isNative) return;
  IncomingFiles.addListener('files', async ({ files }) => {
    const out: File[] = [];
    for (const f of files || []) {
      try {
        const res = await fetch(Capacitor.convertFileSrc('file://' + f.path));
        const blob = await res.blob();
        out.push(new File([blob], f.name || 'document', { type: f.mimeType || blob.type }));
      } catch (e) {
        console.warn('could not read incoming file', f, e);
      }
    }
    if (out.length) cb(out);
  });
}

/** Android hardware back button: close open dialogs, then go back a screen, then leave the app. */
export async function setupBackButton(canGoBack: () => boolean) {
  if (!isNative) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', () => {
    const sheets = document.querySelectorAll('.backdrop.show');
    if (sheets.length) {
      const top = sheets[sheets.length - 1] as HTMLElement;
      (top.querySelector('.sheet-head .icon-btn') as HTMLElement | null)?.click();
      return;
    }
    if (document.getElementById('busy')?.classList.contains('show')) return;
    if (canGoBack()) history.back();
    else App.minimizeApp();
  });
}
