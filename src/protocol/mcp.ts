import { z } from "zod";

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
