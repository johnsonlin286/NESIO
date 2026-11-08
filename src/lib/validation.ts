import type { z } from "zod";
import { Errors } from "./errors.js";

/** Parse dengan zod; lempar VALIDATION_ERROR berisi daftar field yang salah. */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw Errors.validation(
    result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}
