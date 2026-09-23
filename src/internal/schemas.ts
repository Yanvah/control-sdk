import { z } from "zod";

export const identifierSchema = z.string().min(1).max(256).regex(/\S/);
export const actionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);
export const requestIdSchema = z.uuidv4();
export const dateTimeSchema = z.iso.datetime({ precision: 3 });
