/** Use one store namespace per product connection, shared by all its instances. */
export interface ReplayStore {
  /**
   * Atomically claim a lowercase UUIDv4 until expiresAt (exclusive). Return false
   * if already claimed, and reject on storage failure. Never evict an unexpired claim.
   */
  consume(requestId: string, expiresAt: Date): Promise<boolean>;
}
