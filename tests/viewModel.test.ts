import { describe, expect, it, vi } from 'vitest';
import { createStarterDocument } from '../src/domain';
import type { LayoutRepository } from '../src/repository';
import type { LayoutDocument } from '../src/types';
import { ExpoSketchViewModel } from '../src/viewModel';

const fakeRepository = (initial: LayoutDocument | null = null): LayoutRepository => ({
  load: vi.fn(async () => initial ?? createStarterDocument()),
  save: vi.fn(async (_document) => {}),
});

describe('ExpoSketchViewModel', () => {
  it('initializes and updates the selected layout', async () => {
    const repository = fakeRepository();
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    expect(vm.state.phase).toBe('ready');
    const count = vm.state.document.elements.length;
    vm.addElement('booth');
    expect(vm.state.document.elements).toHaveLength(count + 1);
    expect(vm.state.selectedId).toContain('booth-');
  });

  it('updates analysis immediately after moving an element into an overlap', () => {
    const vm = new ExpoSketchViewModel(fakeRepository());
    vm.moveElement('stage-1', 4.5, 2.5);
    expect(vm.state.analysis.overlaps.length).toBeGreaterThan(0);
  });

  it('recovers the example if repository loading fails', async () => {
    const repository: LayoutRepository = { load: vi.fn(async () => { throw new Error('bad storage'); }), save: vi.fn(async () => {}) };
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    expect(vm.state.phase).toBe('error');
    expect(vm.state.document.title).toContain('春日创意市集');
  });

  it('shows a save error without dropping the working document', async () => {
    const save = vi.fn(async (_document: LayoutDocument): Promise<void> => { throw new Error('quota'); });
    const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save };
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    vm.addElement('stage');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.document.elements.some((element) => element.kind === 'stage' && element.id.startsWith('stage-'))).toBe(true);
    expect(vm.state.notice.tone).toBe('error');
    expect(vm.state.saveStatus).toBe('error');
    save.mockImplementation(async () => {});
    vm.retrySave();
  });

  it('retries a failed save automatically and clears the error notice once recovered', async () => {
    vi.useFakeTimers();
    try {
      let shouldFail = true;
      const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save: vi.fn(async () => { if (shouldFail) throw new Error('quota'); }) };
      const vm = new ExpoSketchViewModel(repository);
      await vm.initialize();
      vm.addElement('booth');
      await vi.advanceTimersByTimeAsync(0);
      expect(vm.state.saveStatus).toBe('error');
      expect(vm.state.notice.tone).toBe('error');
      shouldFail = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(vm.state.saveStatus).toBe('saved');
      expect(vm.state.notice.tone).toBe('success');
      expect(vm.state.notice.message).toContain('保存已恢复');
      expect(vm.state.lastSavedAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retrying with backoff while storage stays full', async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => { throw new Error('quota'); });
      const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save };
      const vm = new ExpoSketchViewModel(repository);
      await vm.initialize();
      vm.addElement('booth');
      await vi.advanceTimersByTimeAsync(0);
      expect(save).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(save).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(save).toHaveBeenCalledTimes(3);
      expect(vm.state.saveStatus).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('manual retrySave persists pending changes and restores the saved state', async () => {
    let shouldFail = true;
    const save = vi.fn(async (_document: LayoutDocument) => { if (shouldFail) throw new Error('quota'); });
    const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save };
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    vm.addElement('booth');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.saveStatus).toBe('error');
    shouldFail = false;
    vm.retrySave();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.saveStatus).toBe('saved');
    expect(vm.state.notice.tone).toBe('success');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('clears a stuck save-failure notice once a later edit is saved', async () => {
    let shouldFail = true;
    const repository: LayoutRepository = { load: vi.fn(async () => createStarterDocument()), save: vi.fn(async () => { if (shouldFail) throw new Error('quota'); }) };
    const vm = new ExpoSketchViewModel(repository);
    await vm.initialize();
    vm.addElement('booth');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.notice.tone).toBe('error');
    shouldFail = false;
    vm.moveElement('stage-1', 12, 4);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vm.state.saveStatus).toBe('saved');
    expect(vm.state.notice.tone).toBe('success');
    expect(vm.state.notice.message).toContain('保存已恢复');
  });

  it('ignores invalid dimensions instead of corrupting the working selection', () => {
    const vm = new ExpoSketchViewModel(fakeRepository());
    const before = vm.state.document.elements[0].width;
    vm.resizeSelected(0, 0);
    expect(vm.state.document.elements[0].width).toBe(before);
  });
});
