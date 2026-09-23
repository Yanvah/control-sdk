import { readExampleCredentials } from "../config.ts";
import { createExampleProduct } from "./product.ts";

const credentials = readExampleCredentials();

export const productA = createExampleProduct({
  product: { id: "product-a", name: "Example Product A" },
  auth: credentials.productA,
  writable: true,
});

export const productB = createExampleProduct({
  product: { id: "product-b", name: "Example Product B" },
  auth: credentials.productB,
  writable: false,
});
