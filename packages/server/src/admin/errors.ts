/** Operator-facing error: the message is safe to print (never contains secrets). */
export class AdminError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminError';
  }
}
