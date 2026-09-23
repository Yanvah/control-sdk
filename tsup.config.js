export default {
  entry: {
    index: "src/index.ts",
    "server/index": "src/server/index.ts",
    "client/index": "src/client/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  dts: true,
  clean: true,
  splitting: false,
  external: ["zod"],
};
