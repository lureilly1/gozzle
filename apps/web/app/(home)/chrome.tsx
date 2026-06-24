'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from './home.module.css';
import { C, GITHUB_URL, GOOSE, INSTALL_COMMAND } from './theme';

function CopyInstall() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title="Copy install command"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        background: '#0e0e0e',
        border: '1px solid rgba(242,193,78,.4)',
        borderRadius: 7,
        padding: '8px 12px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 12.5,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: C.muted }}>$</span>
      <code style={{ color: C.text }}>{INSTALL_COMMAND}</code>
      <span style={{ color: C.amber, fontWeight: 700, minWidth: 56, textAlign: 'right' }}>
        {copied ? 'copied!' : 'copy'}
      </span>
    </button>
  );
}

export function SiteNav() {
  return (
    <div
      className={styles.nav}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 14,
        padding: '0 4px',
        fontSize: 13,
      }}
    >
      <Link
        href="/"
        style={{
          fontWeight: 700,
          color: C.amber,
          letterSpacing: '-.4px',
          fontSize: 15,
          textDecoration: 'none',
        }}
      >
        gozzle
      </Link>

      <div
        className={styles.navLinks}
        style={{ display: 'flex', alignItems: 'center', gap: 26 }}
      >
        <Link href="/docs">docs</Link>
        <span style={{ color: '#3a3a36' }}>·</span>
        <Link href="/faq">faq</Link>
        <span style={{ color: '#3a3a36' }}>·</span>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          github
        </a>
      </div>

      <CopyInstall />
    </div>
  );
}

export function TitleBar({ label = '~/gozzle' }: { label?: string }) {
  const dot = (bg: string) => (
    <span
      style={{
        width: 11,
        height: 11,
        borderRadius: '50%',
        background: bg,
        display: 'inline-block',
      }}
    />
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 13,
        padding: '11px 16px',
        borderBottom: '1px solid rgba(242,193,78,.22)',
        background: 'rgba(255,255,255,.015)',
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        {dot('#ff5f56')}
        {dot('#febc2e')}
        {dot('#28c840')}
      </div>
      <span
        style={{
          marginLeft: 'auto',
          color: '#3f3f3a',
          fontSize: 11,
          letterSpacing: '.5px',
        }}
      >
        {label}
      </span>
    </div>
  );
}

/** Bottom terminal bar showing the install command — the open-source CTA. */
export function InstallBar() {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; ignore
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '13px 18px',
        borderTop: '1px solid rgba(242,193,78,.28)',
        background: 'rgba(242,193,78,.035)',
      }}
    >
      <span
        style={{
          color: C.amber,
          fontSize: 14,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        gozzle-$
      </span>
      <span style={{ color: C.muted, fontSize: 14 }}>#</span>
      <button
        type="button"
        onClick={copy}
        title="Copy install command"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          padding: 0,
          margin: 0,
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <code style={{ color: C.text, fontSize: 14, flex: 1, minWidth: 0 }}>
          {INSTALL_COMMAND}
        </code>
        <span
          style={{
            color: C.amber,
            fontSize: 12.5,
            fontWeight: 700,
            minWidth: 56,
            textAlign: 'right',
            flex: 'none',
          }}
        >
          {copied ? 'copied!' : 'copy'}
        </span>
      </button>
      <span
        className={styles.blink}
        style={{
          width: 8,
          height: 16,
          background: C.amber,
          display: 'inline-block',
          flex: 'none',
        }}
      />
      <pre
        className={styles.bob}
        style={{
          margin: 0,
          color: C.amber,
          fontSize: 9,
          lineHeight: 1.05,
          flex: 'none',
        }}
      >
        {GOOSE}
      </pre>
    </div>
  );
}

