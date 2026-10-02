import type { Analysis, LayoutMode, Notice, SaveStatus } from '../../types';

interface StatusBarProps { mode: LayoutMode; analysis: Analysis; notice: Notice; elementCount: number; saveStatus: SaveStatus; lastSavedAt: number | null; onRetrySave: () => void; onModeChange: (mode: LayoutMode) => void; }

const SAVE_STATE_LABEL: Record<SaveStatus, string> = { idle: '自动保存', saving: '正在保存…', saved: '自动保存', error: '保存失败' };

export function StatusBar({ mode, analysis, notice, elementCount, saveStatus, lastSavedAt, onRetrySave, onModeChange }: StatusBarProps) {
  const issues = analysis.overlaps.length + analysis.bounds.length + analysis.channels.length;
  const savedTime = lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : null;
  const saveDetail = saveStatus === 'error'
    ? (savedTime ? `· 上次保存 ${savedTime} · 当前更改未保存` : '· 当前更改未保存')
    : (savedTime ? `· 已保存 ${savedTime}` : '');
  return <div className="bottom-bar">
    <div className="status-message"><span className={`status-dot ${notice.tone}`} />{notice.message}<small>{saveDetail}</small>{saveStatus === 'error' ? <button type="button" className="retry-save-button" onClick={onRetrySave}>立即重试</button> : null}</div>
    <div className="bottom-meta"><span>{elementCount} 个元素</span><span className={issues ? 'has-issues' : 'is-clear'}>{issues ? `${issues} 项待检查` : '布局状态良好'}</span><span className={`save-state ${saveStatus}`}>{SAVE_STATE_LABEL[saveStatus]}</span></div>
    <div className="mode-tabs"><button type="button" className={mode === 'edit' ? 'active' : ''} onClick={() => onModeChange('edit')}>编辑</button><button type="button" className={mode === 'inspect' ? 'active' : ''} onClick={() => onModeChange('inspect')}>检查 {issues ? <b>{issues}</b> : null}</button><button type="button" className={mode === 'path' ? 'active' : ''} onClick={() => onModeChange('path')}>路径预览</button></div>
  </div>;
}
