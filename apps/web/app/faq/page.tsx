'use client';

import { useState } from 'react';
import styles from '../(home)/home.module.css';
import { C, GITHUB_URL, GOOSE, mono } from '../(home)/theme';
import { SiteNav, TitleBar } from '../(home)/chrome';

const FAQS: Array<{ q: string; tag: string; a: string }> = [
  {
    q: 'What is gozzle?',
    tag: '// basics',
    a: 'An MCP server that gives your AI agent a faithful, read-only local slice of your ClickHouse — so it can run, test, and prove migrations and queries before anything touches production.',
  },
  {
    q: 'Does my data ever leave my machine?',
    tag: '// privacy',
    a: 'No. gozzle runs the local slice with chDB on your own machine. Your data, queries, and schemas stay local — nothing is uploaded or sent to us.',
  },
  {
    q: 'Which tools does it work with?',
    tag: '// setup',
    a: 'Anything that speaks MCP: Claude Code, Cursor, Codex, Claude Desktop, and your CI. Install the server once and your agent gets the gozzle tools.',
  },
  {
    q: 'What does it actually catch?',
    tag: '// proof',
    a: 'ReplacingMergeTree duplicates without FINAL, materialized views that silently drop rows, migrations that trigger multi-hour mutations, full-table scans, and aggregates broken by missing State/Merge.',
  },
  {
    q: 'Is it free?',
    tag: '// license',
    a: 'Yes — gozzle is free and open source under the Apache 2.0 license. Install it from npm, read the source on GitHub, and contributions are welcome.',
  },
  {
    q: 'How do I get started?',
    tag: '// setup',
    a: 'Install it from npm, run gozzle init to print the MCP config for your AI host, and point it at your ClickHouse read-only. The Quickstart walks through the first check.',
  },
];

export default function FaqPage() {
  const [open, setOpen] = useState<Record<number, boolean>>({ 0: true });

  const toggle = (i: number) =>
    setOpen((prev) => ({ ...prev, [i]: !prev[i] }));

  return (
    <div
      className={`${mono.className} ${styles.root}`}
      style={{
        width: '100%',
        height: '100vh',
        minHeight: 680,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '28px 24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 920,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <SiteNav />

        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            border: '1px solid rgba(242,193,78,.45)',
            borderRadius: 12,
            background: 'linear-gradient(180deg,#101010,#0c0c0c)',
            boxShadow:
              '0 0 0 1px rgba(0,0,0,.4),0 40px 90px -30px rgba(0,0,0,.9),inset 0 1px 0 rgba(255,255,255,.03)',
            overflow: 'hidden',
          }}
        >
          <TitleBar label="~/man/gozzle" />

          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              overflow: 'auto',
              padding: '26px 36px',
            }}
          >
            <div
              style={{
                color: C.comment,
                fontSize: 12,
                letterSpacing: '.3px',
                marginBottom: 4,
              }}
            >
              // man gozzle — frequently asked
            </div>
            <h1
              className={styles.headline}
              style={{
                margin: '0 0 18px',
                fontSize: 28,
                fontWeight: 800,
                color: C.amber,
                letterSpacing: '-1px',
              }}
            >
              FAQ
            </h1>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {FAQS.map((item, i) => {
                const isOpen = !!open[i];
                return (
                  <div
                    key={item.q}
                    className={styles.faqItem}
                    onClick={() => toggle(i)}
                    style={{
                      borderTop: '1px solid rgba(255,255,255,.07)',
                      padding: '15px 8px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 11,
                      }}
                    >
                      <span
                        style={{
                          color: C.amber,
                          fontWeight: 700,
                          fontSize: 14,
                          flex: 'none',
                        }}
                      >
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span
                        style={{
                          color: '#ededdf',
                          fontSize: 14.5,
                          fontWeight: 500,
                          flex: 1,
                        }}
                      >
                        {item.q}
                      </span>
                      <span
                        style={{ color: C.green, fontSize: 12, flex: 'none' }}
                      >
                        {item.tag}
                      </span>
                    </div>
                    {isOpen ? (
                      <div
                        style={{
                          margin: '11px 0 2px',
                          paddingLeft: 25,
                          color: '#b8b8ae',
                          fontSize: 13.5,
                          lineHeight: 1.65,
                          maxWidth: 680,
                        }}
                      >
                        {item.a}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

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
            <span style={{ color: '#8f8f85', fontSize: 13.5 }}>
              still stuck?{' '}
              <a
                href={`${GITHUB_URL}/issues`}
                target="_blank"
                rel="noreferrer"
                style={{ color: C.amber, textDecoration: 'none' }}
              >
                open an issue on GitHub
              </a>
            </span>
            <pre
              className={styles.bob}
              style={{
                margin: '0 0 0 auto',
                color: C.amber,
                fontSize: 9,
                lineHeight: 1.05,
                flex: 'none',
              }}
            >
              {GOOSE}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
