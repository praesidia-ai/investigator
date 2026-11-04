/** Support chats older than this are deleted by the nightly job. */
export const CHAT_TTL_DAYS = 30;

export function isExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > CHAT_TTL_DAYS * 24 * 60 * 60 * 1000;
}
