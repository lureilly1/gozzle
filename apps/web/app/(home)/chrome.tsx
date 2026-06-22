'use client';

import Link from 'next/link';
import styles from './home.module.css';
import { C, GITHUB_URL, GOOSE, INSTALL_COMMAND } from './theme';

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

      <Link className={styles.cta} href="/docs/quickstart">
        get started &gt;
      </Link>
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
      <code style={{ color: C.text, fontSize: 14, flex: 1, minWidth: 0 }}>
        {INSTALL_COMMAND}
      </code>
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

export function SiteFooter() {
  const sep = <span style={{ color: '#3a3a36' }}>·</span>;
  return (
    <div
      className={styles.nav}
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 18,
        fontSize: 12,
        marginTop: 22,
      }}
    >
      <Link href="/docs">Docs</Link>
      {sep}
      <a href={GITHUB_URL} target="_blank" rel="noreferrer">
        GitHub
      </a>
      {sep}
      <Link href="/docs/privacy">Privacy</Link>
    </div>
  );
}
