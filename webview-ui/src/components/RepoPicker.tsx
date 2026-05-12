import React, { useState } from 'react';

import { CHARACTER_NAMES, PALETTE_COUNT } from '../constants.js';

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
  background: 'var(--color-bg)',
  border: '2px solid var(--color-border)',
  padding: 20,
  minWidth: 400,
  maxWidth: 520,
  maxHeight: '90%',
  overflowY: 'auto',
  boxShadow: '2px 2px 0px var(--color-bg-dark)',
};

const titleStyle: React.CSSProperties = {
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 18,
  color: 'var(--color-accent-bright)',
  marginBottom: 12,
};

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  maxHeight: 200,
  overflowY: 'auto',
};

const itemStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: 'var(--color-text)',
  cursor: 'pointer',
  borderBottom: '1px solid var(--color-border)',
};

const buttonStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--color-accent)',
  border: '2px solid var(--color-border)',
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
  color: 'var(--color-text-muted)',
  boxShadow: 'none',
};

const searchInputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  background: 'var(--color-bg-dark)',
  border: '2px solid var(--color-border)',
  color: 'var(--color-text)',
  outline: 'none',
  marginBottom: 10,
};

const paletteGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(6, 1fr)',
  gap: 4,
  marginBottom: 10,
};

const paletteItemStyle = (selected: boolean): React.CSSProperties => ({
  padding: '4px',
  border: selected ? '2px solid var(--color-accent-bright)' : '2px solid var(--color-border)',
  background: selected ? 'var(--color-active-bg)' : 'var(--color-bg-dark)',
  cursor: 'pointer',
  textAlign: 'center',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 10,
  color: selected ? 'var(--color-text)' : 'var(--color-text-muted)',
});

interface RepoPickerProps {
  recentRepos: string[];
  workDirRepos?: string[];
  onPick: (repoPath: string, palette: number) => void;
  onBrowse: () => void;
  onCancel: () => void;
}

export function RepoPicker({ recentRepos, workDirRepos = [], onPick, onBrowse, onCancel }: RepoPickerProps) {
  const [search, setSearch] = useState('');
  const [palette, setPalette] = useState(0);

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
        <div style={titleStyle}>New Agent</div>

        {/* Character selector */}
        <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          Character
        </div>
        <div style={paletteGridStyle}>
          {Array.from({ length: PALETTE_COUNT }, (_, i) => (
            <div
              key={i}
              style={paletteItemStyle(palette === i)}
              onClick={() => setPalette(i)}
            >
              {CHARACTER_NAMES[i] ?? `#${i}`}
            </div>
          ))}
        </div>

        {/* Search */}
        <input
          type="text"
          placeholder="Search repos..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={searchInputStyle}
        />

        {!hasAny && (
          <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
            Add a Work Directory in Settings to scan for repos.
          </div>
        )}

        {filteredWorkDir.length > 0 && (
          <>
            <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              Workspace
            </div>
            <ul style={listStyle}>
              {filteredWorkDir.map((repo) => (
                <li
                  key={repo}
                  style={itemStyle}
                  onClick={() => onPick(repo, palette)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-thumb)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {repo.split('/').pop() || repo}
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{repo}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        {filteredRecent.length > 0 && (
          <>
            <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              Recent
            </div>
            <ul style={listStyle}>
              {filteredRecent.map((repo) => (
                <li
                  key={repo}
                  style={itemStyle}
                  onClick={() => onPick(repo, palette)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-bg-thumb)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {repo.split('/').pop() || repo}
                  <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{repo}</div>
                </li>
              ))}
            </ul>
          </>
        )}

        {hasAny && filteredWorkDir.length === 0 && filteredRecent.length === 0 && (
          <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6, textAlign: 'center' }}>
            No repos match "{search}"
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
