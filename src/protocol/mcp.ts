import { z } from "zod";
import { validSecretName } from "./secrets.ts";

const headerName = z
  .string()
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/);
const headerValue = z.union([
  z
    .object({ value: z.string().min(1).max(8192).regex(/^[\t\x20-\x7e]+$/) })
    .strict(),
  z
    .object({ secret: z.string().refine(validSecretName, "Invalid secret reference") })
    .strict(),
]);
const common = {
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .refine((id) => id !== "workflow", "Reserved connection ID"),
  name: z.string().trim().min(1).max(100),
  enabledByDefault: z.boolean().default(true),
};
export const mcpConnectionsSchema = z
  .array(
    z.discriminatedUnion("transport", [
      z
        .object({
          ...common,
          transport: z.literal("stdio"),
          command: z.string().min(1),
          args: z.array(z.string()).default([]),
        })
        .strict(),
      z
        .object({
          ...common,
          transport: z.literal("http"),
          url: z.url().refine((value) => {
            const url = new URL(value);
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password
            );
          }),
          oauth: z.boolean().default(false),
          headers: z
            .record(headerName, headerValue)
            .refine((entries) => Object.keys(entries).length <= 32)
            .default({}),
        })
        .strict(),
    ]),
  )
  .max(100)
  .refine(
    (entries) =>
      new Set(entries.map((entry) => entry.id)).size === entries.length,
    "Connection IDs must be unique",
  );
export type McpConnection = z.infer<typeof mcpConnectionsSchema>[number];
export type McpStatus = {
  id: string;
  state: "connecting" | "connected" | "failed";
  tools: number;
};
