import React, { useState } from 'react';

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--color-bg-dark)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};

const modalStyle: React.CSSProperties = {
  background: 'var(--pixel-bg)',
  border: '2px solid var(--pixel-border)',
  padding: 20,
  minWidth: 360,
  maxWidth: 480,
  boxShadow: '2px 2px 0px var(--color-bg-dark)',
};

const titleStyle: React.CSSProperties = {
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 16,
  color: 'var(--pixel-header-text)',
  marginBottom: 12,
};

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  maxHeight: 240,
  overflowY: 'auto',
};

const itemStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: 'var(--pixel-text)',
  cursor: 'pointer',
  borderBottom: '1px solid var(--pixel-border)',
};

const buttonStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--pixel-accent)',
  border: '2px solid var(--pixel-border)',
  padding: '8px 12px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: 'var(--color-text)',
  cursor: 'pointer',
  marginTop: 10,
  boxShadow: '2px 2px 0px var(--color-bg-dark)',
};

const cancelStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'transparent',
  color: 'var(--pixel-text-dim)',
};

interface RepoPickerProps {
  recentRepos: string[];
  workDirRepos?: string[];
  onPick: (repoPath: string) => void;
  onBrowse: () => void;
  onCancel: () => void;
}

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  background: 'var(--color-bg-thumb)',
  border: '2px solid var(--pixel-border)',
  color: 'var(--pixel-text)',
  outline: 'none',
  marginBottom: 10,
};

export function RepoPicker({ recentRepos, workDirRepos = [], onPick, onBrowse, onCancel }: RepoPickerProps) {
  const [search, setSearch] = useState('');

  const filter = (repos: string[]) => {
    if (!search) return repos;
    const q = search.toLowerCase();
    return repos.filter((r) => r.toLowerCase().includes(q));
  };

  const filteredWorkDir = filter(workDirRepos);
  const filteredRecent = filter(recentRepos);
  const hasAny = workDirRepos.length > 0 || recentRepos.length > 0;

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={titleStyle}>New Agent — Pick a Repo</div>

        <input
          type="text"
          placeholder="Search repos..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={searchInputStyle}
        />

        {!hasAny && (
          <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--pixel-text-dim)', marginBottom: 6 }}>
            Scanning...
          </div>
        )}

        {filteredWorkDir.length > 0 && (
          <>
            <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--pixel-text-dim)', marginBottom: 6 }}>
              Workspace
            </div>
            <ul style={listStyle}>
              {filteredWorkDir.map((repo) => (
                <li
                  key={repo}
                  style={itemStyle}
                  onClick={() => onPick(repo)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-thumb)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {repo.split('/').pop() || repo}
                  <div style={{ fontSize: 11, color: 'var(--pixel-text-dim)' }}>{repo}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        {filteredRecent.length > 0 && (
          <>
            <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--pixel-text-dim)', marginBottom: 6 }}>
              Recent
            </div>
            <ul style={listStyle}>
              {filteredRecent.map((repo) => (
                <li
                  key={repo}
                  style={itemStyle}
                  onClick={() => onPick(repo)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-thumb)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {repo.split('/').pop() || repo}
                  <div style={{ fontSize: 11, color: 'var(--pixel-text-dim)' }}>{repo}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        {hasAny && filteredWorkDir.length === 0 && filteredRecent.length === 0 && (
          <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--pixel-text-dim)', marginBottom: 6, textAlign: 'center' }}>
            No repos match &quot;{search}&quot;
          </div>
        )}

        <button style={buttonStyle} onClick={onBrowse}>
          Browse...
        </button>

        <button style={cancelStyle} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
