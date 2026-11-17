// Stop the server started by launch.mjs, and only that one.
import { readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pidFile = join(dirname(fileURLToPath(import.meta.url)), '.server.json');

async function stop() {
  let saved;
  try { saved = JSON.parse(readFileSync(pidFile, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') { console.log('LoRA Studio is not running (no launcher record).'); return; } throw e; }
  let status;
  try {
    status = await fetch(`http://127.0.0.1:${saved.port}/api/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
  } catch {
    try { process.kill(saved.pid, 0); }
    catch (e) { if (e.code === 'ESRCH') { unlinkSync(pidFile); console.log('LoRA Studio is already stopped.'); return; } throw e; }
    throw new Error('The saved process is alive but cannot be identified as LoRA Studio. It was left running.');
  }
  if (status.app !== 'lora-studio' || status.pid !== saved.pid) throw new Error('The port or saved process belongs to another app. It was left running.');
  process.kill(saved.pid);
  unlinkSync(pidFile);
  console.log(`Stopped LoRA Studio (PID ${saved.pid}).`);
}

stop().catch((e) => { console.error('Could not stop LoRA Studio: ' + e.message); process.exitCode = 1; });
