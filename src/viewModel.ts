import { createElement, createStarterDocument, analyzeLayout, findElement, getBoundingBox, normalizeRotation } from './domain';
import type { LayoutRepository } from './repository';
import type { Analysis, ElementKind, LayoutDocument, LayoutMode, Notice, RenderElement, SaveStatus, ViewPhase } from './types';

export interface ExpoSketchState {
  phase: ViewPhase;
  document: LayoutDocument;
  renderElements: RenderElement[];
  selectedId: string | null;
  selectedElement: RenderElement | null;
  mode: LayoutMode;
  analysis: Analysis;
  notice: Notice;
  lastSavedAt: number | null;
  saveStatus: SaveStatus;
  hasUnsavedChanges: boolean;
}

const toRenderElements = (document: LayoutDocument): RenderElement[] => document.elements.map((element) => {
  const box = getBoundingBox(element);
  return { ...element, displayWidth: box.width, displayHeight: box.height, occupiedArea: Number((box.width * box.height).toFixed(1)) };
});

const starter = createStarterDocument();
const starterRenderElements = toRenderElements(starter);

const SAVE_FAILURE_NOTICE: Notice = { tone: 'error', message: '本地保存失败，改动仅保留在当前页面' };
const SAVE_RECOVERED_NOTICE: Notice = { tone: 'success', message: '保存已恢复，全部改动已存入本地' };
const SAVE_IDLE_NOTICE: Notice = { tone: 'success', message: '改动已保存到本地' };
const RETRY_SCHEDULE_MS = [2000, 5000, 15000];
const RECOVERED_NOTICE_VISIBLE_MS = 4000;

type Listener = () => void;

export class ExpoSketchViewModel {
  private listeners = new Set<Listener>();
  private stateValue: ExpoSketchState = {
    phase: 'loading',
    document: starter,
    renderElements: starterRenderElements,
    selectedId: 'stage-1',
    selectedElement: starterRenderElements.find((element) => element.id === 'stage-1') ?? null,
    mode: 'edit',
    analysis: analyzeLayout(createStarterDocument()),
    notice: { tone: 'info', message: '正在恢复最近布局…' },
    lastSavedAt: null,
    saveStatus: 'idle',
    hasUnsavedChanges: false,
  };

  private saving = false;
  private queuedLatest = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveredNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private saveFailureNoticeActive = false;
  private initialized = false;
  private readonly handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (this.stateValue.hasUnsavedChanges) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  private readonly handleOnline = () => { void this.retrySave(); };

  constructor(private readonly repository: LayoutRepository) {}

  get state() { return this.stateValue; }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    window.addEventListener('online', this.handleOnline);
    try {
      const document = await this.repository.load();
      this.commit({ document, selectedId: document.elements[0]?.id ?? null, phase: 'ready', notice: { tone: 'success', message: '布局已就绪，可开始编辑' } });
    } catch {
      this.commit({ phase: 'error', notice: { tone: 'error', message: '布局读取失败，已载入安全示例' } });
    }
  }

  dispose() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.recoveredNoticeTimer) clearTimeout(this.recoveredNoticeTimer);
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    window.removeEventListener('online', this.handleOnline);
  }

  selectElement(id: string) { this.commit({ selectedId: id }); }

  setMode(mode: LayoutMode) { this.commit({ mode, notice: { tone: 'info', message: mode === 'inspect' ? '检查模式已开启：拖动元素查看即时提示' : mode === 'path' ? '路径模式已开启：入口到重点区域的访问路线已生成' : '编辑模式已开启' } }); }

  addElement(kind: ElementKind) {
    const element = createElement(kind, this.stateValue.document.elements.length, this.stateValue.document.field);
    const document = { ...this.stateValue.document, elements: [...this.stateValue.document.elements, element] };
    this.commitAndPersist({ document, selectedId: element.id, notice: { tone: 'success', message: `${element.name} 已加入场地` } });
  }

  removeSelected() {
    if (!this.stateValue.selectedId) return;
    const removed = findElement(this.stateValue.document, this.stateValue.selectedId);
    const elements = this.stateValue.document.elements.filter((element) => element.id !== this.stateValue.selectedId);
    this.commitAndPersist({ document: { ...this.stateValue.document, elements }, selectedId: elements[0]?.id ?? null, notice: { tone: 'info', message: `${removed?.name ?? '元素'} 已移除` } });
  }

  moveElement(id: string, x: number, y: number) {
    const elements = this.stateValue.document.elements.map((element) => element.id === id ? { ...element, x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) } : element);
    this.commitAndPersist({ document: { ...this.stateValue.document, elements } });
  }

  resizeSelected(width: number, height: number) {
    const id = this.stateValue.selectedId;
    if (!id || width <= 0 || height <= 0) return;
    const elements = this.stateValue.document.elements.map((element) => element.id === id ? { ...element, width: Number(width.toFixed(1)), height: Number(height.toFixed(1)) } : element);
    this.commitAndPersist({ document: { ...this.stateValue.document, elements } });
  }

  rotateSelected() {
    const id = this.stateValue.selectedId;
    if (!id) return;
    const elements = this.stateValue.document.elements.map((element) => element.id === id ? { ...element, rotation: normalizeRotation(element.rotation + 90) } : element);
    this.commitAndPersist({ document: { ...this.stateValue.document, elements }, notice: { tone: 'info', message: '方向已旋转 90°' } });
  }

  renameSelected(name: string) {
    const id = this.stateValue.selectedId;
    if (!id || !name.trim()) return;
    const elements = this.stateValue.document.elements.map((element) => element.id === id ? { ...element, name: name.trim() } : element);
    this.commitAndPersist({ document: { ...this.stateValue.document, elements } });
  }

  resizeField(width: number, height: number) {
    if (width < 12 || height < 10) return;
    this.commitAndPersist({ document: { ...this.stateValue.document, field: { width: Number(width.toFixed(1)), height: Number(height.toFixed(1)) } }, notice: { tone: 'success', message: '场地尺寸已更新' } });
  }

  renameProject(title: string) {
    if (!title.trim()) return;
    this.commitAndPersist({ document: { ...this.stateValue.document, title: title.trim() } });
  }

  resetExample() {
    const document = createStarterDocument();
    this.commitAndPersist({ document, selectedId: 'stage-1', mode: 'edit', notice: { tone: 'success', message: '已恢复示例布局' } });
  }

  /** 用户手动重试：立刻再保存一次当前文档，并重新开始自动重试节奏。 */
  retrySave() {
    if (this.stateValue.saveStatus !== 'error' || !this.stateValue.hasUnsavedChanges) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retryAttempt = 0;
    void this.flushSave();
  }

  private commitAndPersist(patch: Partial<ExpoSketchState>) {
    this.commit(patch);
    // 保存失败期间继续编辑：取消等待中的退避重试，立即尝试一次最新内容
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.saving) {
      this.queuedLatest = true;
    } else {
      void this.flushSave();
    }
  }

  private scheduleRetry() {
    if (this.retryTimer) return;
    const delay = RETRY_SCHEDULE_MS[Math.min(this.retryAttempt, RETRY_SCHEDULE_MS.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushSave();
    }, delay);
  }

  /** 恢复提示展示几秒后自动收起；若用户又触发了别的提示，则不覆盖。 */
  private scheduleRecoveredNoticeDismissal() {
    if (this.recoveredNoticeTimer) clearTimeout(this.recoveredNoticeTimer);
    this.recoveredNoticeTimer = setTimeout(() => {
      this.recoveredNoticeTimer = null;
      if (this.stateValue.notice === SAVE_RECOVERED_NOTICE) {
        this.commit({ notice: SAVE_IDLE_NOTICE });
      }
    }, RECOVERED_NOTICE_VISIBLE_MS);
  }

  private async flushSave() {
    if (this.saving) {
      this.queuedLatest = true;
      return;
    }
    this.saving = true;
    try {
      // 保存期间若有新编辑进来，会置位 queuedLatest，落盘完成后再追存最新内容
      while (true) {
        this.queuedLatest = false;
        const snapshot = this.stateValue.document;
        this.commit({ saveStatus: 'saving', hasUnsavedChanges: true });
        await this.repository.save(snapshot);
        if (this.queuedLatest) continue;
        if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
        this.retryAttempt = 0;
        const failureNoticeWasActive = this.saveFailureNoticeActive;
        this.commit({
          saveStatus: 'idle',
          hasUnsavedChanges: false,
          lastSavedAt: Date.now(),
          notice: failureNoticeWasActive ? SAVE_RECOVERED_NOTICE : this.stateValue.notice,
        });
        if (failureNoticeWasActive) this.scheduleRecoveredNoticeDismissal();
        break;
      }
    } catch {
      this.queuedLatest = false;
      this.commit({ saveStatus: 'error', hasUnsavedChanges: true, notice: SAVE_FAILURE_NOTICE });
      this.scheduleRetry();
    } finally {
      this.saving = false;
    }
  }

  private commit(patch: Partial<ExpoSketchState>) {
    const next = { ...this.stateValue, ...patch };
    const renderElements = toRenderElements(next.document);
    this.stateValue = { ...next, renderElements, selectedElement: renderElements.find((element) => element.id === next.selectedId) ?? null, analysis: analyzeLayout(next.document) };
    this.saveFailureNoticeActive = next.notice === SAVE_FAILURE_NOTICE;
    this.listeners.forEach((listener) => listener());
  }
}
