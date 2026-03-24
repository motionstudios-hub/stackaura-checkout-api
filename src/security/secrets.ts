import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const SECRET_PREFIX = 'enc:v1';
const SECRET_SEPARATOR = ':';
const NON_PRODUCTION_FALLBACK_SECRET = 'stackaura-dev-credentials-secret';

function trimToNull(value: string | null | undefined) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function resolveCredentialEncryptionSecret() {
  const explicit = trimToNull(process.env.CREDENTIALS_ENCRYPTION_SECRET);
  if (explicit) {
    return explicit;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('CREDENTIALS_ENCRYPTION_SECRET is required in production');
  }

  return NON_PRODUCTION_FALLBACK_SECRET;
}

function buildCipherKey(secret: string) {
  return createHash('sha256').update(secret).digest();
}

export function isEncryptedSecret(value: string | null | undefined) {
  const trimmed = trimToNull(value);
  return Boolean(trimmed?.startsWith(`${SECRET_PREFIX}${SECRET_SEPARATOR}`));
}

export function encryptStoredSecret(value: string | null | undefined) {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return null;
  }

  if (isEncryptedSecret(trimmed)) {
    return trimmed;
  }

  const key = buildCipherKey(resolveCredentialEncryptionSecret());
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(trimmed, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    SECRET_PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(SECRET_SEPARATOR);
}

export function decryptStoredSecret(value: string | null | undefined) {
  const trimmed = trimToNull(value);
  if (!trimmed) {
    return null;
  }

  if (!isEncryptedSecret(trimmed)) {
    return trimmed;
  }

  const parts = trimmed.split(SECRET_SEPARATOR);
  if (parts.length !== 5) {
    throw new Error('Stored secret is malformed');
  }
  const [prefixRoot, prefixVersion, ivRaw, tagRaw, payloadRaw] = parts;
  const prefix = `${prefixRoot}${SECRET_SEPARATOR}${prefixVersion}`;
  if (prefix !== SECRET_PREFIX || !ivRaw || !tagRaw || !payloadRaw) {
    throw new Error('Stored secret is malformed');
  }

  const key = buildCipherKey(resolveCredentialEncryptionSecret());
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payloadRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');

  return trimToNull(decrypted);
}

export function assertCredentialEncryptionPolicy() {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  resolveCredentialEncryptionSecret();
}
