import { afterEach, describe, expect, it } from 'vitest';
import { createStarterDocument } from '../src/domain';
import { BrowserStorageService } from '../src/storageService';

// jsdom 不提供 IndexedDB，这里放一个"打开即失败"的最小桩，验证降级路径
const installFailingIndexedDb = () => {
  const failingOpen = () => {
    const request = {
      set onerror(handler: (event: Event) => void) {
        queueMicrotask(() => handler(Object.assign(new Event('error'), { error: new Error('idb blocked') })));
      },
    };
    return request as unknown as IDBOpenDBRequest;
  };
  Object.defineProperty(globalThis, 'indexedDB', { value: { open: failingOpen }, configurable: true });
};

describe('BrowserStorageService fallback', () => {
  afterEach(() => {
    window.localStorage.clear();
    // @ts-expect-error 清理测试注入的桩
    delete globalThis.indexedDB;
  });

  it('falls back to localStorage when IndexedDB cannot be opened', async () => {
    installFailingIndexedDb();

    const storage = new BrowserStorageService();
    const document = createStarterDocument();
    await storage.write(document);

    expect(window.localStorage.getItem('exposketch.document.v1')).toBe(JSON.stringify(document));
    const readBack = await storage.read();
    expect(readBack).toEqual(document);
  });
});
