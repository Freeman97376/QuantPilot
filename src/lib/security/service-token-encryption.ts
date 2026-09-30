import crypto from 'node:crypto';

const TOKEN_PREFIX = 'qp-secret-v1';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function encryptionKey(): Buffer {
  const value = process.env.ENCRYPTION_KEY?.trim() ?? '';
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(
      'ENCRYPTION_KEY must be configured as a stable 64-character hexadecimal secret before storing server service tokens.',
    );
  }
  return Buffer.from(value, 'hex');
}

export function isEncryptedServiceToken(value: string): boolean {
  return value.startsWith(`${TOKEN_PREFIX}:`);
}

export function encryptServiceToken(value: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [TOKEN_PREFIX, iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join(':');
}

export function decryptServiceToken(value: string): string {
  if (!isEncryptedServiceToken(value)) return value;
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    throw new Error('Stored service token has an invalid encrypted format.');
  }
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const encrypted = Buffer.from(parts[3], 'base64url');
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== AUTH_TAG_BYTES || encrypted.byteLength === 0) {
      throw new Error('invalid encrypted payload');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv, {
      authTagLength: AUTH_TAG_BYTES,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Stored service token could not be decrypted.');
  }
}
