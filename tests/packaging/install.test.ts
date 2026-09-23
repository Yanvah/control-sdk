import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const npmCli = process.env.npm_execpath;
const packSchema = z
  .array(
    z.object({
      filename: z.string().regex(/^[a-zA-Z0-9_.-]+\.tgz$/),
      files: z.array(z.object({ path: z.string() })),
    }),
  )
  .length(1);
const metadataSchema = z.object({
  name: z.literal("@yanvah/control"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.literal("module"),
  license: z.literal("Apache-2.0"),
  private: z.literal(false).optional(),
  sideEffects: z.literal(false),
  engines: z.object({ node: z.literal(">=22") }),
  dependencies: z.strictObject({ zod: z.string() }),
  exports: z.record(
    z.string(),
    z.object({ types: z.string(), import: z.string() }).strict(),
  ),
  repository: z.object({
    type: z.literal("git"),
    url: z.literal("git+https://github.com/yanvah/control-sdk.git"),
  }),
  publishConfig: z.object({
    access: z.literal("public"),
    provenance: z.literal(true),
  }),
});
let temporary: string | undefined;
let consumer: string;
let packageFiles: string[];

async function npm(args: string[], cwd: string): Promise<string> {
  if (!npmCli)
    throw new Error(
      "Run packaging tests through npm test or npm run test:package.",
    );
  const { stdout } = await execute(process.execPath, [npmCli, ...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
  return stdout;
}

async function pack(
  directory: string,
  destination: string,
): Promise<z.output<typeof packSchema>[number]> {
  const output = await npm(
    [
      "pack",
      directory,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ],
    root,
  );
  const [result] = packSchema.parse(JSON.parse(output));
  if (!result) throw new Error("npm pack did not return a tarball.");
  return result;
}

function readExample(readme: string, name: string): string {
  const section = readme
    .split(`<!-- quickstart-${name} -->`)[1]
    ?.split(`<!-- /quickstart-${name} -->`)[0];
  const code = section?.match(/```ts\r?\n([\s\S]*?)\r?\n```/)?.[1];
  if (!code) throw new Error(`README is missing the ${name} example.`);
  return `${code}\n`;
}

beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), "yanvah-packed-consumer-"));
  consumer = join(temporary, "consumer");
  await mkdir(consumer);
  const packed = await pack(root, temporary);
  packageFiles = packed.files.map((file) => file.path);
  const dependencies: Record<string, string> = {
    "@yanvah/control": `file:${join(temporary, packed.filename)}`,
  };
  // Pack the already-installed, locked dependencies so tests never contact a registry.
  for (const name of ["zod", "typescript", "@types/node", "undici-types"]) {
    const installed = dirname(require.resolve(`${name}/package.json`));
    const dependency = await pack(installed, temporary);
    dependencies[name] = `file:${join(temporary, dependency.filename)}`;
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "yanvah-packed-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies,
    }),
  );
  await npm(
    ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"],
    consumer,
  );
  const readme = await readFile(join(root, "README.md"), "utf8");
  await writeFile(join(consumer, "route.ts"), readExample(readme, "route"));
  await writeFile(join(consumer, "client.ts"), readExample(readme, "client"));
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: ["node"],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        verbatimModuleSyntax: true,
        outDir: "build",
      },
      include: ["route.ts", "client.ts"],
    }),
  );
  await cp(
    new URL("./fixtures/run.mjs", import.meta.url),
    join(consumer, "run.mjs"),
  );
}, 120_000);

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test("the tarball contains only distributable files and deliberate ESM entry points", async () => {
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CHANGELOG.md",
    "docs/PROTOCOL.md",
    "docs/THREAT_MODEL.md",
    "docs/DEPLOYMENT.md",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/server/index.js",
    "dist/server/index.d.ts",
    "dist/client/index.js",
    "dist/client/index.d.ts",
  ];
  expect(packageFiles).toEqual(expect.arrayContaining(required));
  for (const file of packageFiles) {
    expect(
      required.includes(file) ||
        /^dist\/(?:client\/|server\/)?[A-Za-z0-9_-]+\.(?:js|d\.ts)$/.test(file),
      `Unexpected packed file: ${file}`,
    ).toBe(true);
  }
  const installed = join(consumer, "node_modules/@yanvah/control");
  expect((await lstat(installed)).isSymbolicLink()).toBe(false);
  expect(await realpath(installed)).toBe(
    join(await realpath(consumer), "node_modules/@yanvah/control"),
  );
  const metadata = metadataSchema.parse(
    JSON.parse(await readFile(join(installed, "package.json"), "utf8")),
  );
  expect(Object.keys(metadata.exports)).toEqual([".", "./server", "./client"]);
  for (const entry of Object.values(metadata.exports)) {
    expect(packageFiles).toContain(entry.import.replace(/^\.\//, ""));
    expect(packageFiles).toContain(entry.types.replace(/^\.\//, ""));
  }
});

test("an independent project compiles the README with NodeNext and Bundler resolution and runs signed HTTP calls", async () => {
  const compiler = join(consumer, "node_modules/typescript/bin/tsc");
  await execute(process.execPath, [compiler, "--project", "tsconfig.json"], {
    cwd: consumer,
    timeout: 30_000,
  });
  await execute(
    process.execPath,
    [
      compiler,
      "--project",
      "tsconfig.json",
      "--module",
      "ESNext",
      "--moduleResolution",
      "Bundler",
      "--noEmit",
    ],
    { cwd: consumer, timeout: 30_000 },
  );
  const { stdout } = await execute(process.execPath, ["run.mjs"], {
    cwd: consumer,
    timeout: 15_000,
    env: {
      ...process.env,
      YANVAH_CONTROL_KEY_ID: "packed-example",
      YANVAH_CONTROL_SECRET: randomBytes(32).toString("hex"),
    },
  });
  expect(stdout.trim()).toBe("Packed README examples passed.");
}, 75_000);
