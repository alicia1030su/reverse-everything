import { spawn } from 'node:child_process';
import path from 'node:path';

const WINDOWS_TAR = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe');

export function extractZip(archive, destination, timeoutMs = 60_000) {
  const [command, args] = process.platform === 'win32'
    ? [WINDOWS_TAR, ['-xf', archive, '-C', destination]]
    : ['unzip', ['-q', archive, '-d', destination]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`ZIP extraction timed out: ${output}`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ZIP extraction exited ${code}: ${output}`));
    });
  });
}
