import type { Analysis, LayoutMode, Notice, SaveStatus } from '../../types';

interface StatusBarProps {
  mode: LayoutMode;
  analysis: Analysis;
  notice: Notice;
  elementCount: number;
  lastSavedAt: number | null;
  saveStatus: SaveStatus;
  hasUnsavedChanges: boolean;
  onModeChange: (mode: LayoutMode) => void;
  onRetrySave: () => void;
}

const savedLabel = (lastSavedAt: number | null) => lastSavedAt
  ? `已保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  : '已全部保存';

export function StatusBar({ mode, analysis, notice, elementCount, lastSavedAt, saveStatus, hasUnsavedChanges, onModeChange, onRetrySave }: StatusBarProps) {
  const issues = analysis.overlaps.length + analysis.bounds.length + analysis.channels.length;

  const saveIndicator = saveStatus === 'error'
    ? { tone: 'error', text: '保存失败 · 有未保存改动', action: true }
    : saveStatus === 'saving'
      ? { tone: 'warning', text: '正在保存…', action: false }
      : hasUnsavedChanges
        ? { tone: 'warning', text: '有未保存改动', action: false }
        : { tone: 'success', text: savedLabel(lastSavedAt), action: false };

  // 保存失败时状态栏以持久的保存状态为准，避免普通操作提示把失败信息盖掉
  const shownNotice = saveStatus === 'error'
    ? { tone: 'error' as const, message: '本地保存失败，改动仅保留在当前页面，关闭页面前请重试' }
    : notice;

  return <div className="bottom-bar">
    <div className="status-message">
      <span className={`status-dot ${shownNotice.tone}`} />
      {shownNotice.message}
      {saveStatus === 'error' && <button type="button" className="save-retry-button" onClick={onRetrySave}>立即重试</button>}
    </div>
    <div className="bottom-meta">
      <span>{elementCount} 个元素</span>
      <span className={issues ? 'has-issues' : 'is-clear'}>{issues ? `${issues} 项待检查` : '布局状态良好'}</span>
      <span className={`save-state save-state-${saveIndicator.tone}`}>
        <i className={`save-state-dot ${saveIndicator.tone === 'warning' && saveStatus === 'saving' ? 'is-pulsing' : ''}`} />
        {saveIndicator.text}
      </span>
    </div>
    <div className="mode-tabs"><button type="button" className={mode === 'edit' ? 'active' : ''} onClick={() => onModeChange('edit')}>编辑</button><button type="button" className={mode === 'inspect' ? 'active' : ''} onClick={() => onModeChange('inspect')}>检查 {issues ? <b>{issues}</b> : null}</button><button type="button" className={mode === 'path' ? 'active' : ''} onClick={() => onModeChange('path')}>路径预览</button></div>
  </div>;
}
