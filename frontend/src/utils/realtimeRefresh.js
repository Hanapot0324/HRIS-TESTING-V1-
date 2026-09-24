/**
 * Delay before refetching after a server broadcast that reaches every
 * connected client at once (e.g. "notificationCreated" after an announcement
 * is sent to all employees). A fixed delay makes every browser hit the API in
 * the same instant; a random spread turns that spike into a steady trickle.
 */
export function broadcastRefreshDelay(baseMs = 250, spreadMs = 3000) {
  return baseMs + Math.floor(Math.random() * spreadMs);
}
