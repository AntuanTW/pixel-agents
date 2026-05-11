import React from 'react';

const bannerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  background: 'var(--color-bg)',
  border: '2px solid var(--color-warning)',
  padding: '8px 14px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: 'var(--color-warning)',
  zIndex: 60,
  boxShadow: '2px 2px 0px var(--color-bg-dark)',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const buttonStyle: React.CSSProperties = {
  background: 'var(--color-warning)',
  border: '2px solid var(--pixel-border)',
  padding: '4px 10px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 12,
  color: 'var(--color-text)',
  cursor: 'pointer',
  boxShadow: '2px 2px 0px var(--color-bg-dark)',
};

const dismissStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--pixel-text-dim)',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 12,
  cursor: 'pointer',
};

interface MigrationBannerProps {
  agentCount: number;
  onMigrate: () => void;
  onDismiss: () => void;
}

export function MigrationBanner({ agentCount, onMigrate, onDismiss }: MigrationBannerProps) {
  return (
    <div style={bannerStyle}>
      <span>
        {agentCount} agent(s) still use the old terminal system. Migrate to in-extension chat?
      </span>
      <button style={buttonStyle} onClick={onMigrate}>
        Migrate
      </button>
      <button style={dismissStyle} onClick={onDismiss}>
        {'✕'}
      </button>
    </div>
  );
}
