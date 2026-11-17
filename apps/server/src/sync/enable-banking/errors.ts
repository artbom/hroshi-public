/** The bank or the owner closed the consent before it ran out; only the owner can renew it. */
export class ConsentLostError extends Error {
  override name = 'ConsentLostError';
}

/** The consent ran out and the owner already had the reminders; each morning's sync fails quietly until it is renewed. */
export class ConsentExpiredError extends Error {
  override name = 'ConsentExpiredError';
}
