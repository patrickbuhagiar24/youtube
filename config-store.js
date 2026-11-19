/*
 * Stores the folder handle chosen on the Drive setup page. Loaded by both the
 * setup tab and the service worker so clearing settings removes the handle too.
 */
// eslint-disable-next-line no-unused-vars, no-var
var YousubConfigStore = (() => {
  const DB_NAME = 'yousub-config';
  const STORE = 'folders';
  const KEY = 'setupFolder';

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function run(mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  return {
    saveFolderHandle: (handle) => run('readwrite', (store) => store.put(handle, KEY)),
    loadFolderHandle: () => run('readonly', (store) => store.get(KEY)),
    clearFolderHandle: () => run('readwrite', (store) => store.delete(KEY))
  };
})();
