import React from 'react';

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
  onPick: (repoPath: string) => void;
  onBrowse: () => void;
  onCancel: () => void;
}

export function RepoPicker({ recentRepos, onPick, onBrowse, onCancel }: RepoPickerProps) {
  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        <div style={titleStyle}>New Agent — Pick a Repo</div>

        {recentRepos.length > 0 && (
          <>
            <div style={{ fontFamily: 'FS Pixel Sans, monospace', fontSize: 12, color: 'var(--pixel-text-dim)', marginBottom: 6 }}>
              Recent
            </div>
            <ul style={listStyle}>
              {recentRepos.map((repo) => (
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
