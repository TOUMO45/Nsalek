// Runs before publishing (firebase.json "predeploy"): refuses a build that is for the emulators, that
// lost its accounts, or that names another project. Usage: node scripts/check-release.mjs [outDir]
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = "nsalek-app";

export function releaseProblems(outDir) {
  const js = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? js(join(d, e.name)) : e.name.endsWith(".js") ? [readFileSync(join(d, e.name), "utf8")] : []));
  const all = js(join(outDir, "_next", "static")).join("\n");
  const out = [];
  if (/demo-nsalek/.test(all)) out.push("this build talks to the emulators (demo-nsalek)");
  if (/konashi/.test(all)) out.push("this build names the clinic's project");
  if (!all.includes(`"${PROJECT}"`)) out.push(`this build has no accounts: ${PROJECT} is missing (.env.production)`);
  if (!/AIza[\w-]{35}/.test(all)) out.push("this build has a placeholder instead of the project's public key (.env.production)");
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = releaseProblems(resolve(process.argv[2] ?? "out"));
  for (const p of problems) console.error("NOT PUBLISHED:", p);
  process.exit(problems.length ? 1 : 0);
}
