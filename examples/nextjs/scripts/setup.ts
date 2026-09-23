import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

const envFile = new URL("../.env.local", import.meta.url);
const contents = [
  "# Local demonstration credentials. Never commit this file.",
  "PRODUCT_A_KEY_ID=example-product-a",
  `PRODUCT_A_SECRET=${randomBytes(32).toString("hex")}`,
  "PRODUCT_B_KEY_ID=example-product-b",
  `PRODUCT_B_SECRET=${randomBytes(32).toString("hex")}`,
  "",
].join("\n");

try {
  // Exclusive creation preserves existing credentials; secrets never go to stdout.
  await writeFile(envFile, contents, { flag: "wx", mode: 0o600 });
  console.log(
    "Created examples/nextjs/.env.local with separate random credentials.",
  );
} catch (error) {
  if (z.object({ code: z.literal("EEXIST") }).safeParse(error).success) {
    console.log("Kept existing examples/nextjs/.env.local unchanged.");
  } else {
    console.error("Could not create the example environment file.");
    process.exitCode = 1;
  }
}
