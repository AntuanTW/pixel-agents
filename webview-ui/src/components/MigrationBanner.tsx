import React from 'react';

const bannerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  background: '#1a1a2e',
  border: '2px solid #ff8c00',
  padding: '8px 14px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 13,
  color: '#ff8c00',
  zIndex: 60,
  boxShadow: '2px 2px 0px #0a0a14',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const buttonStyle: React.CSSProperties = {
  background: '#ff8c00',
  border: '2px solid var(--pixel-border)',
  padding: '4px 10px',
  fontFamily: 'FS Pixel Sans, monospace',
  fontSize: 12,
  color: '#fff',
  cursor: 'pointer',
  boxShadow: '2px 2px 0px #0a0a14',
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
