/** Full-process exit fallback used when the React renderer tree has crashed. */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/** Exits the tray application, retaining native destroy for backend mismatch. */
export async function exitAfterRendererCrash(): Promise<void> {
  try {
    await invoke('exit_application');
  } catch {
    try {
      await getCurrentWindow().destroy();
    } catch {
      window.close();
    }
  }
}
