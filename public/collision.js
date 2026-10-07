// Visual effects follow resolved cargo outcomes; they never decide a result.
export function isShipwreck(round) {
  return !!(round?.containers?.length === 3 && round.containers.every(c => c.status === 'lost'));
}

export function collisionFor(from, to, type = 'sail') {
  if (type !== 'sail' || !from || !to || from.id !== to.id) return null;
  const lost = to.containers.filter(c => c.status === 'lost' && from.containers.some(old => old.id === c.id && old.status === 'onboard')).map(c => c.id);
  return lost.length ? {kind: isShipwreck(to) ? 'iceberg' : 'debris', lost} : null;
}

export function transitionDuration(type, collision, reducedMotion = false) {
  if (reducedMotion) return 90;
  return collision?.kind === 'iceberg' ? 2650 : collision ? 1750 : type === 'sail' ? 950 : 620;
}
