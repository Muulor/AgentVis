import { describe, expect, it } from 'vitest';
import {
  getManagedRuntimeRoot,
  inspectPyvenvHermeticityFromConfig,
  parsePyvenvConfig,
} from '../pythonRuntimeHermeticity';

describe('pythonRuntimeHermeticity', () => {
  const runtimeDir = 'C:/Users/Test/AppData/Roaming/com.agentvis.app/runtime/python-v1';

  it('parses pyvenv.cfg key values', () => {
    expect(parsePyvenvConfig('home = C:\\Python314\ninclude-system-site-packages = false')).toEqual(
      {
        home: 'C:\\Python314',
        'include-system-site-packages': 'false',
      }
    );
  });

  it('treats embedded runtime under app-managed runtime as hermetic', () => {
    const result = inspectPyvenvHermeticityFromConfig(
      [
        'home = C:\\Users\\Test\\AppData\\Roaming\\com.agentvis.app\\runtime\\python-embed-3.13',
        'executable = C:\\Users\\Test\\AppData\\Roaming\\com.agentvis.app\\runtime\\python-embed-3.13\\python.exe',
      ].join('\n'),
      runtimeDir
    );

    expect(result).toEqual({
      status: 'hermetic',
      externalRoots: [],
    });
  });

  it('detects venvs created from host Python as non-hermetic', () => {
    const result = inspectPyvenvHermeticityFromConfig(
      [
        'home = C:\\Python314',
        'executable = C:\\Python314\\python.exe',
        'command = C:\\Python314\\python.exe -m venv C:\\Users\\Test\\AppData\\Roaming\\com.agentvis.app\\runtime\\python-v1\\.venv',
      ].join('\n'),
      runtimeDir
    );

    expect(result.status).toBe('nonHermetic');
    expect(result.externalRoots).toEqual(['C:\\Python314', 'C:\\Python314\\python.exe']);
  });

  it('uses the shared runtime parent as the managed root', () => {
    expect(getManagedRuntimeRoot(runtimeDir)).toBe(
      'C:/Users/Test/AppData/Roaming/com.agentvis.app/runtime'
    );
  });
});
