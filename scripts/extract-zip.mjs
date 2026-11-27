import { spawn } from 'node:child_process';
import sevenZip from '7zip-bin';

const path7za = typeof sevenZip === 'string' ? sevenZip : sevenZip.path7za;

export function extractZip(archive, destination, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(path7za, ['x', '-y', `-o${destination}`, archive], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString()).slice(-16_000); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`7-Zip extraction timed out: ${output}`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`7-Zip extraction exited ${code}: ${output}`));
    });
  });
}
