export class LookupError extends Error {
  constructor(message, status = 502) { super(message); this.name = 'LookupError'; this.status = status; }
}
