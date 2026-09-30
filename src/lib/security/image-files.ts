export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENTS = 8;

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export interface ValidatedImageType {
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  extension: '.png' | '.jpg' | '.gif' | '.webp';
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function detectImageType(bytes: Uint8Array): ValidatedImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
    && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  return null;
}

export function validateImageBytes(
  bytes: Uint8Array,
  declaredMimeType?: string | null
): ValidatedImageType {
  if (bytes.byteLength <= 0) {
    throw new ImageValidationError('Image file is empty.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ImageValidationError('Image file exceeds the 10 MB limit.');
  }

  const detected = detectImageType(bytes);
  if (!detected) {
    throw new ImageValidationError(
      'Unsupported or invalid image. Only PNG, JPEG, GIF, and WebP files are accepted.'
    );
  }

  const declared = declaredMimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (declared && declared !== detected.mimeType) {
    throw new ImageValidationError(
      `Image content does not match the declared MIME type (${declaredMimeType}).`
    );
  }
  return detected;
}
