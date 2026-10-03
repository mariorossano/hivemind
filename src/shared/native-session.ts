import { z } from 'zod';

/** Host-reported launch metadata, NOT credentials, process evidence or task authority. */
export const nativeSessionSchema = z.object({
  software: z.enum(['codex', 'claude']),
  sessionId: z.string().uuid().nullable(),
  model: z.string().max(160).regex(/^(?:[A-Za-z0-9][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+-]*)?)?$/),
  effort: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
}).strict();

export type NativeSession = z.infer<typeof nativeSessionSchema>;

/** Never use a name, --last, a transcript path or another provider's ID as a fallback. */
export function nativeSessionId(value: string): string {
  const parsed = z.string().uuid().safeParse(value.trim());
  if (!parsed.success) throw new Error('Native resume needs the exact conversation UUID');
  return parsed.data;
}
