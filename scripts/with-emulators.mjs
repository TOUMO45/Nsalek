// Runs a command with the Firebase emulators of the project "demo-nsalek" (which never reaches a real
// project), and on Windows stops the Firestore emulator that firebase-tools leaves running.
// Usage: node scripts/with-emulators.mjs <command...>
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const port = JSON.parse(readFileSync("firebase.json", "utf8")).emulators.firestore.port;

function clean() {
  if (process.platform !== "win32") return;
  const ps = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"; if ($p.CommandLine -like '*cloud-firestore-emulator*') { Stop-Process -Id $p.ProcessId -Force } }`;
  spawnSync("powershell", ["-NoProfile", "-Command", ps]);
}

clean();
const command = process.argv.slice(2).join(" ");
const r = spawnSync(`firebase emulators:exec --project demo-nsalek --only auth,firestore "${command}"`, { stdio: "inherit", shell: true });
clean();
process.exit(r.status ?? 1);
