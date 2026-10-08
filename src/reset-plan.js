// Discord deletes a channel's threads with the parent channel. Only threads
// outside Harklet's managed channels need a separate delete permission.
export function detachedProjectThreads(channels, threads) {
  const managedParents = new Set(channels.map(channel => channel.id));
  return threads.filter(thread => !managedParents.has(thread.parentId));
}
