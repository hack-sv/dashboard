// AES-GCM encryption for OAuth access tokens at rest in D1. The key is a
// base64-encoded 32-byte secret in TOKEN_ENC_KEY. Stored blobs are
// base64(iv[12] || ciphertext); tokens never leave the Worker in plaintext.

function bytesToB64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64)
  if (raw.length !== 32) {
    throw new Error('TOKEN_ENC_KEY must be base64 of exactly 32 bytes')
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptToken(keyB64: string, plaintext: string): Promise<string> {
  const key = await importKey(keyB64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)),
  )
  const blob = new Uint8Array(iv.length + ct.length)
  blob.set(iv, 0)
  blob.set(ct, iv.length)
  return bytesToB64(blob)
}

export async function decryptToken(keyB64: string, blob: string): Promise<string> {
  const key = await importKey(keyB64)
  const bytes = b64ToBytes(blob)
  const iv = bytes.slice(0, 12)
  const ct = bytes.slice(12)
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}
