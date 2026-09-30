export class RequestBodyError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'RequestBodyError';
  }
}

function assertValidLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('Request body limit must be a positive safe integer.');
  }
}

function declaredBodyLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new RequestBodyError('Invalid Content-Length header.');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RequestBodyError('Invalid Content-Length header.');
  }
  return parsed;
}

export async function readLimitedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  assertValidLimit(maxBytes);
  const declaredLength = declaredBodyLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new RequestBodyError('Request body is too large.', 413);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('request body limit exceeded').catch(() => undefined);
        throw new RequestBodyError('Request body is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readLimitedJson(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readLimitedRequestBody(request, maxBytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError('Request body must be valid UTF-8 JSON.');
  }
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new RequestBodyError('Invalid JSON body.');
  }
}

export async function readLimitedFormData(
  request: Request,
  maxBytes: number,
): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('multipart/form-data')) {
    throw new RequestBodyError('Expected a multipart/form-data request.');
  }
  const bytes = await readLimitedRequestBody(request, maxBytes);
  const headers = new Headers(request.headers);
  headers.set('content-length', String(bytes.byteLength));
  try {
    const bufferedRequest = new Request(request.url, {
      method: 'POST',
      headers,
      body: bytes as unknown as BodyInit,
    });
    return await bufferedRequest.formData();
  } catch {
    throw new RequestBodyError('Invalid multipart form body.');
  }
}
