import { spawn } from "node:child_process";
import console from "node:console";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import process from "node:process";
import { URL } from "node:url";

const require = createRequire(import.meta.url);
const command = process.argv[2];
if (command === "dev" || command === "build" || command === "typegen") {
  // Next emits conflicting globals for dev/build: vercel/next.js#91895.
  // Regenerate the current mode's declarations while retaining full type checking.
  const staleTypes = command === "dev" ? "types" : "dev/types";
  await rm(new URL(`../.next/${staleTypes}`, import.meta.url), {
    recursive: true,
    force: true,
  });
}
const child = spawn(
  process.execPath,
  [require.resolve("next/dist/bin/next"), ...process.argv.slice(2)],
  {
    cwd: new URL("../", import.meta.url),
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "inherit",
  },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", () => {
  console.error("Could not start the Next.js example command.");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
