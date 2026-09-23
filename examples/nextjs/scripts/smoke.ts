import { existsSync } from "node:fs";
import { readExampleCredentials } from "../config.ts";
import { runSmoke } from "./flow.ts";

try {
  const environmentFile = new URL("../.env.local", import.meta.url);
  if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
  await runSmoke({
    ...readExampleCredentials(),
    origin: process.env.EXAMPLE_ORIGIN ?? "http://127.0.0.1:3001",
    onStep: (message) => console.log(`✓ ${message}`),
  });
  console.log("Local smoke test passed.");
} catch {
  console.error(
    "Local smoke test failed. Check the example server and matching credentials.",
  );
  process.exitCode = 1;
}
