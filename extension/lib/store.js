// A value in chrome.storage.session with serialized updates, so concurrent
// events don't overwrite each other. No UI, so it can be tested outside the browser.

const MAX_PRUNES = 5;

// update(fn): `fn` mutates the value and returns something truthy when it changed.
// Options: beforeSave(value) runs before each save; after(changed, value) after it.
// Session storage holds 10 MB: when a save doesn't fit, prune(value) (which may be
// async) drops what matters least and returns whether it freed anything, and the
// save is tried again.
// A save that still fails is dropped, and the value is read back from storage.
export function makeStore(key, { after, beforeSave, prune } = {}) {
  const area = () => chrome.storage.session;
  let cache = null;
  let chain = Promise.resolve();
  const load = async () => (cache ||= (await area().get(key))[key] || {});
  const save = async () => {
    for (let round = 0; ; round++) {
      try {
        return await area().set({ [key]: cache });
      } catch (e) {
        if (!/quota/i.test(e.message) || round >= MAX_PRUNES || !(await prune?.(cache))) throw e;
      }
    }
  };
  return {
    update(fn) {
      chain = chain
        .then(async () => {
          const changed = fn(await load());
          if (!changed) return;
          beforeSave?.(cache);
          try {
            await save();
          } catch (e) {
            cache = null; // what's stored is the truth
            throw e;
          }
          after?.(changed, cache);
        })
        .catch((e) => console.error(e));
      return chain;
    },
    async get() {
      await chain;
      return load();
    },
  };
}

// Pruning for the per-tab video lists: drops the oldest half of all the videos.
export function pruneOldestItems(tabs) {
  const all = Object.entries(tabs).flatMap(([tab, list]) => list.map((item) => ({ tab, item })));
  if (!all.length) return false;
  all.sort((a, b) => a.item.time - b.item.time);
  const drop = new Set(all.slice(0, Math.ceil(all.length / 2)).map((x) => x.item));
  for (const [tab, list] of Object.entries(tabs)) {
    const kept = list.filter((x) => !drop.has(x));
    if (kept.length) tabs[tab] = kept;
    else delete tabs[tab];
  }
  return true;
}

// Pruning for the job list: drops the oldest half of the ended jobs (never active
// ones), calling forget(job) for each. False when there's no ended job to drop.
export function pruneEndedJobs(jobs, forget = () => {}) {
  const ended = Object.values(jobs).filter((j) => ['done', 'failed', 'cancelled'].includes(j.state));
  if (!ended.length) return false;
  ended.sort((a, b) => (a.endedAt || a.created) - (b.endedAt || b.created));
  for (const j of ended.slice(0, Math.ceil(ended.length / 2))) {
    forget(j);
    delete jobs[j.id];
  }
  return true;
}
