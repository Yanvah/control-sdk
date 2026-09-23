import { z } from "zod";

const secretSchema = z
  .string()
  .regex(/\S/)
  .refine((value) => {
    const bytes = Buffer.byteLength(value, "utf8");
    return bytes >= 32 && bytes <= 1024;
  });
const credentialsSchema = z.strictObject({
  keyId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  secret: secretSchema,
});
const connectionsSchema = z
  .strictObject({
    productA: credentialsSchema,
    productB: credentialsSchema,
  })
  .refine(
    ({ productA, productB }) =>
      productA.keyId !== productB.keyId && productA.secret !== productB.secret,
  );

export type ExampleCredentials = z.output<typeof connectionsSchema>;

export function readExampleCredentials(): ExampleCredentials {
  const result = connectionsSchema.safeParse({
    productA: {
      keyId: process.env.PRODUCT_A_KEY_ID,
      secret: process.env.PRODUCT_A_SECRET,
    },
    productB: {
      keyId: process.env.PRODUCT_B_KEY_ID,
      secret: process.env.PRODUCT_B_SECRET,
    },
  });
  if (!result.success) {
    throw new Error(
      "Configure distinct example credentials in .env.local; run npm run example:setup.",
    );
  }
  return result.data;
}
