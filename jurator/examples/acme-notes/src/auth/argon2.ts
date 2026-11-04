// Stand-in for the argon2 package so the demo has no dependencies.
export async function hash(plain: string, _opts: { type: string; memoryCost: number }): Promise<string> {
  return `$argon2id$${Buffer.from(plain).toString('base64url')}`;
}
export async function verify(stored: string, plain: string): Promise<boolean> {
  return stored === (await hash(plain, { type: 'argon2id', memoryCost: 19_456 }));
}
