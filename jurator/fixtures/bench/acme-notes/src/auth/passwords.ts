import { hash, verify } from './argon2.js';

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { type: 'argon2id', memoryCost: 19_456 });
}
export async function checkPassword(stored: string, plain: string): Promise<boolean> {
  return verify(stored, plain);
}
