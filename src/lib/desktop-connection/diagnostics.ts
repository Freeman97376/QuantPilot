import { z } from 'zod';

export const diagnosticEventSchema = z.object({
  appVersion: z.string().min(1).max(32),
  windowsVersion: z.string().min(1).max(128),
  architecture: z.literal('x64'),
  appSchemaVersion: z.number().int().nonnegative(),
  marketSchemaVersion: z.number().int().nonnegative(),
  installationId: z.string().uuid(),
  feature: z.string().min(1).max(128),
  errorCode: z.string().min(1).max(128),
  severity: z.enum(['info', 'warning', 'error', 'fatal']),
  sanitizedStack: z.string().max(16_384).optional(),
  occurredAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
}).strict();

const REDACTIONS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer <redacted>'],
  [/(?:api[_-]?key|password|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<redacted>'],
  [/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s]*/g, '<local-path>'],
  [/(?:prompt|response)\s*[:=]\s*[^\r\n]+/gi, '$1=<redacted>'],
  [/qp_(?:at|rt)_[A-Za-z0-9_-]+/g, '<redacted-token>'],
];

export function redactDiagnosticText(value: string | undefined): string | null {
  if (!value) return null;
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
    .slice(0, 16_384);
}
