import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export function relayLog(root: string, message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  const directory = path.join(root, 'logs');
  const file = path.join(directory, 'relay.log');
  try {
    mkdirSync(directory, { recursive: true });
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) > 256 * 1024) {
      renameSync(file, file + '.1');
    }
    appendFileSync(file, line);
  } catch {
    // A log failure must not stop the relay or produce unbounded output.
  }
}
