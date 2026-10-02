import type { LayoutDocument } from './types';

export interface DocumentStorageService {
  read(): Promise<LayoutDocument | null>;
  write(document: LayoutDocument): Promise<void>;
}

const STORAGE_KEY = 'exposketch.document.v1';

const canUseIndexedDb = () => typeof indexedDB !== 'undefined';

const readLocalStorage = (): LayoutDocument | null => {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as LayoutDocument) : null;
};

export class BrowserStorageService implements DocumentStorageService {
  async read(): Promise<LayoutDocument | null> {
    if (!canUseIndexedDb()) return readLocalStorage();
    try {
      const document = await this.withDatabase((store) => new Promise<LayoutDocument | null>((resolve, reject) => {
        const request = store.get(STORAGE_KEY);
        request.onsuccess = () => resolve((request.result as LayoutDocument | undefined) ?? null);
        request.onerror = () => reject(request.error ?? new Error('读取布局失败'));
      }));
      // IndexedDB 里没有（或曾在降级模式写入过）时，回退查 localStorage
      return document ?? readLocalStorage();
    } catch {
      return readLocalStorage();
    }
  }

  async write(document: LayoutDocument): Promise<void> {
    if (!canUseIndexedDb()) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
      return;
    }
    try {
      await this.withDatabase((store) => new Promise<void>((resolve, reject) => {
        const request = store.put(document, STORAGE_KEY);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error ?? new Error('保存布局失败'));
      }));
    } catch {
      // 配额不足或数据库异常时降级到 localStorage，至少保住当前改动；仍失败则向上抛出触发重试
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
    }
  }

  private withDatabase<T>(run: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('exposketch-db', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('documents');
      request.onerror = () => reject(request.error ?? new Error('打开本地数据库失败'));
      request.onsuccess = () => {
        const transaction = request.result.transaction('documents', 'readwrite');
        run(transaction.objectStore('documents')).then(resolve).catch(reject);
        transaction.oncomplete = () => request.result.close();
      };
    });
  }
}
