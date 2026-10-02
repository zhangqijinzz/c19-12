import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterDocument } from '../src/domain';
import type { LayoutRepository } from '../src/repository';
import type { LayoutDocument } from '../src/types';
import { ExpoSketchViewModel } from '../src/viewModel';

type SaveMode = 'reject' | 'resolve' | 'hold';

interface PendingSave {
  resolve: () => void;
}

const controllableRepository = () => {
  const calls: LayoutDocument[] = [];
  const pending: PendingSave[] = [];
  let mode: SaveMode = 'reject';
  const repository: LayoutRepository = {
    load: vi.fn(async () => createStarterDocument()),
    save: vi.fn((document: LayoutDocument) => {
      calls.push(document);
      return new Promise<void>((resolve, reject) => {
        if (mode === 'reject') {
          queueMicrotask(() => reject(new Error('quota')));
        } else if (mode === 'resolve') {
          queueMicrotask(resolve);
        } else {
          pending.push({ resolve });
        }
      });
    }),
  };
  return {
    repository,
    calls,
    setMode(next: SaveMode) { mode = next; },
    resolveLast() { pending.pop()?.resolve(); },
    pendingCount: () => pending.length,
  };
};

// 假定时器下微任务仍会真实执行，这里只推进微任务队列
const flushMicrotasks = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

describe('ExpoSketchViewModel save recovery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('marks the document as unsaved and enters error state when saves keep failing', async () => {
    const repo = controllableRepository();
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();
    vm.addElement('stage');
    await vi.advanceTimersByTimeAsync(30000);
    // 自动重试（2s/5s/15s）全部失败后仍处于错误状态，且改动没有丢
    expect(vm.state.saveStatus).toBe('error');
    expect(vm.state.hasUnsavedChanges).toBe(true);
    expect(vm.state.notice.tone).toBe('error');
    expect(vm.state.document.elements.some((e) => e.kind === 'stage')).toBe(true);
    vm.dispose();
  });

  it('auto-retries with backoff and clears the failure banner once a save succeeds', async () => {
    const repo = controllableRepository();
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();
    vm.addElement('stage');
    await flushMicrotasks();
    expect(vm.state.saveStatus).toBe('error');

    // 存储恢复：放行下一次保存，第一次自动重试（2s 后）成功
    repo.setMode('resolve');
    await vi.advanceTimersByTimeAsync(2000);

    expect(vm.state.saveStatus).toBe('idle');
    expect(vm.state.hasUnsavedChanges).toBe(false);
    expect(vm.state.lastSavedAt).not.toBeNull();
    expect(vm.state.notice.tone).toBe('success');
    expect(vm.state.notice.message).toContain('恢复');

    // 恢复提示展示几秒后自动收起，不一直挂在状态栏上
    await vi.advanceTimersByTimeAsync(4000);
    expect(vm.state.notice.message).not.toContain('恢复');
    expect(vm.state.saveStatus).toBe('idle');
    vm.dispose();
  });

  it('retries immediately when the user presses retry, even while a backoff timer is pending', async () => {
    const repo = controllableRepository();
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();
    vm.addElement('stage');
    await flushMicrotasks();
    expect(vm.state.saveStatus).toBe('error');

    repo.setMode('resolve');
    vm.retrySave();
    await flushMicrotasks();

    expect(vm.state.saveStatus).toBe('idle');
    expect(vm.state.hasUnsavedChanges).toBe(false);
    expect(repo.calls.length).toBeGreaterThanOrEqual(2);
    expect(repo.calls[repo.calls.length - 1].elements.some((e) => e.kind === 'stage')).toBe(true);
    vm.dispose();
  });

  it('keeps retrying on schedule while storage keeps failing', async () => {
    const repo = controllableRepository();
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();
    vm.addElement('stage');
    await flushMicrotasks();
    const attemptsAfterFirstFailure = repo.calls.length;

    await vi.advanceTimersByTimeAsync(2000);
    expect(repo.calls.length).toBe(attemptsAfterFirstFailure + 1);
    expect(vm.state.saveStatus).toBe('error');

    await vi.advanceTimersByTimeAsync(5000);
    expect(repo.calls.length).toBe(attemptsAfterFirstFailure + 2);
    expect(vm.state.saveStatus).toBe('error');
    vm.dispose();
  });

  it('coalesces rapid edits into a single in-flight save and always persists the latest content', async () => {
    const repo = controllableRepository();
    repo.setMode('hold');
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();

    // 第一次保存挂起，期间连续编辑只会合并，不会并发写入
    vm.moveElement('stage-1', 2, 2);
    vm.moveElement('stage-1', 4, 4);
    vm.moveElement('stage-1', 6, 6);
    await flushMicrotasks();
    expect(repo.pendingCount()).toBe(1);

    repo.resolveLast();
    await flushMicrotasks();
    // 第一次落盘后追存一次最新内容，写入快照已包含 x:6
    expect(repo.calls.length).toBe(2);
    expect(repo.calls[repo.calls.length - 1].elements.find((e) => e.id === 'stage-1')).toMatchObject({ x: 6, y: 6 });

    repo.resolveLast();
    await flushMicrotasks();
    expect(vm.state.saveStatus).toBe('idle');
    expect(vm.state.hasUnsavedChanges).toBe(false);
  });

  it('retries immediately with the latest content when the user keeps editing after a failure', async () => {
    const repo = controllableRepository();
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();
    vm.addElement('stage');
    await flushMicrotasks();
    expect(vm.state.saveStatus).toBe('error');

    // 退避等待期间继续编辑：应立即发起一次保存，而不是等定时器
    const callsBeforeEdit = repo.calls.length;
    repo.setMode('resolve');
    vm.moveElement('stage-1', 3, 3);
    await flushMicrotasks();
    expect(repo.calls.length).toBe(callsBeforeEdit + 1);
    expect(repo.calls[repo.calls.length - 1].elements.find((e) => e.id === 'stage-1')).toMatchObject({ x: 3, y: 3 });
    expect(vm.state.saveStatus).toBe('idle');
    vm.dispose();
  });

  it('warns before closing the page while there are unsaved changes', async () => {
    const repo = controllableRepository();
    const vm = new ExpoSketchViewModel(repo.repository);
    await vm.initialize();
    vm.addElement('stage');
    await flushMicrotasks();
    expect(vm.state.saveStatus).toBe('error');

    const blockedEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(blockedEvent);
    expect(blockedEvent.defaultPrevented).toBe(true);

    repo.setMode('resolve');
    vm.retrySave();
    await flushMicrotasks();
    const safeEvent = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(safeEvent);
    expect(safeEvent.defaultPrevented).toBe(false);

    vm.dispose();
  });
});
