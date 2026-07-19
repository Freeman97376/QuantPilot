export function isPrismaKnownRequestError(
  error: unknown,
  code: string
): error is Error & { code: string } {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'PrismaClientKnownRequestError' && candidate.code === code;
}
