// Small in-process TTL cache with "single flight" loading.
//
// When 150 candidates open the assessment page in the same second, only ONE
// database fetch is made; every other request waits for that same promise.
class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
    this.generation = 0;
  }

  async get(key, loader) {
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.promise) return hit.promise;
    if (hit && hit.expiresAt > now) return hit.value;

    const generation = this.generation;
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        // If invalidate() ran while loading, do not store possibly stale data.
        if (generation === this.generation) {
          this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        } else {
          this.entries.delete(key);
        }
        return value;
      })
      .catch((error) => {
        this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { promise, expiresAt: 0 });
    return promise;
  }

  invalidateAll() {
    this.generation += 1;
    this.entries.clear();
  }
}

module.exports = { TtlCache };
