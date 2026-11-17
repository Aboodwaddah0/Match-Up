/**
 * The authenticated user performing an action. Controllers build it from the request (see `actorOf`)
 * and pass it to services, so services never need Express objects to know who is calling.
 */
export interface Actor {
  userId: string;
  role: 'USER' | 'ADMIN';
}
