'use client';

import Link from 'next/link';
import styles from './home.module.css';
import { C, GITHUB_URL, mono } from './theme';
import { InstallBar, SiteFooter, SiteNav, TitleBar } from './chrome';

const HEADLINE = 'The ClickHouse brain for your AI agent';

const SUBHEAD =
  'gozzle learns your cluster, sharpens your queries, and tests your migrations ' +
  'against a faithful local slice of prod. An agent harness for ClickHouse, ' +
  'inside your own AI.';

const STEPS = [
  'install the gozzle MCP server',
  'connect read-only to your ClickHouse',
  'ask Claude to verify a query or migration — see it proven',
];

const CATCHES: Array<{ text: string; muted?: string }> = [
  { text: 'ReplacingMergeTree duplicates', muted: '(without FINAL)' },
  { text: 'Materialized views that silently drop rows' },
  { text: 'Migrations that trigger multi-hour mutations' },
  { text: 'Queries scanning the whole table' },
  { text: 'Aggregates wrong from missing State/Merge' },
];

const REASONS = [
  'Runs against your real schema and data shape',
  'Builds local proof before changes ship',
  'Keeps data, queries, and schemas on your machine',
  'Fits into AI coding tools and CI',
];

export default function HomePage() {
  return (
    <div
      className={`${mono.className} ${styles.root}`}
      style={{
        width: '100%',
        height: '100vh',
        minHeight: 660,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '28px 24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1240,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <SiteNav />

        {/* terminal frame */}
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
          <TitleBar />

          <div className={styles.body}>
            <PitchColumn />
            <ProofColumn />
          </div>

          <InstallBar />
        </div>

        <SiteFooter />
      </div>
    </div>
  );
}

function PitchColumn() {
  return (
    <div className={styles.leftCol}>
      <h1
        className={styles.headline}
        style={{
          margin: 0,
          fontSize: 39,
          lineHeight: 1.06,
          fontWeight: 800,
          color: C.amber,
          letterSpacing: '-1.2px',
          textWrap: 'balance',
        }}
      >
        {HEADLINE}
      </h1>

      <p
        style={{
          margin: '15px 0 0',
          fontSize: 14,
          lineHeight: 1.6,
          color: C.textSoft,
          maxWidth: 560,
        }}
      >
        {SUBHEAD}
      </p>

      <div
        style={{
          marginTop: 22,
          color: C.comment,
          fontSize: 12,
          letterSpacing: '.3px',
        }}
      >
        // get started in 3 steps
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          marginTop: 11,
        }}
      >
        {STEPS.map((step) => (
          <div
            key={step}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 11,
              fontSize: 13.5,
              color: C.text,
            }}
          >
            <span style={{ color: C.green, fontWeight: 700 }}>☑</span>
            <span>{step}</span>
          </div>
        ))}
      </div>

      <FlowDiagram />

      <div style={{ display: 'flex', gap: 26, marginTop: 18, flexWrap: 'wrap' }}>
        <Link
          href="/docs/quickstart"
          style={{ color: C.text, textDecoration: 'none', fontSize: 13 }}
        >
          <span style={{ color: C.amber }}>↳ 1 /</span>&nbsp;get started
        </Link>
        <a
          href={GITHUB_URL}
          target="_blank"
          rel="noreferrer"
          style={{ color: C.text, textDecoration: 'none', fontSize: 13 }}
        >
          <span style={{ color: C.amber }}>↳ 2 /</span> star on GitHub
        </a>
      </div>
    </div>
  );
}

function FlowDiagram() {
  return (
    <div
      style={{
        marginTop: 24,
        border: '1px solid rgba(242,193,78,.18)',
        borderRadius: 9,
        padding: '18px 18px 14px',
        background: 'rgba(242,193,78,.025)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'nowrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: C.comment,
              fontSize: 10.5,
              marginBottom: 5,
              letterSpacing: '.4px',
            }}
          >
            //source
          </div>
          <div
            style={{
              border: '1px solid #3a3a34',
              borderRadius: 6,
              padding: '10px 11px',
              color: '#ededdf',
              fontSize: 12.5,
              background: '#0e0e0e',
            }}
          >
            your
            <br />
            ClickHouse
          </div>
        </div>

        <span style={{ color: C.amber, fontSize: 18, flex: 'none' }}>→</span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: C.comment,
              fontSize: 10.5,
              marginBottom: 5,
              letterSpacing: '.4px',
            }}
          >
            //local slice
          </div>
          <div
            style={{
              border: '1px solid rgba(242,193,78,.5)',
              borderRadius: 6,
              padding: '10px 11px',
              color: C.amber,
              fontSize: 12.5,
              background: 'rgba(242,193,78,.05)',
            }}
          >
            chDB
            <br />
            faithful prod slice
          </div>
        </div>

        <span style={{ color: C.amber, fontSize: 18, flex: 'none' }}>→</span>

        <div style={{ flex: 1.05, minWidth: 0 }}>
          <div
            style={{
              color: C.comment,
              fontSize: 10.5,
              marginBottom: 5,
              letterSpacing: '.4px',
            }}
          >
            //outcome
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12,
                color: C.green,
              }}
            >
              <span style={{ fontWeight: 700 }}>✓</span> verified correct
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                fontSize: 12,
                color: C.red,
              }}
            >
              <span style={{ fontWeight: 700 }}>✗</span> 2.4M duplicates caught
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 13,
          textAlign: 'center',
          color: C.comment,
          fontSize: 11,
          letterSpacing: '.3px',
        }}
      >
        └─ fully local and privacy first ─┘
      </div>
    </div>
  );
}

function ProofColumn() {
  return (
    <div className={styles.rightCol}>
      <div style={{ color: C.comment, fontSize: 12, letterSpacing: '.3px' }}>
        // what gozzle catches
      </div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          marginTop: 12,
        }}
      >
        {CATCHES.map((item) => (
          <div key={item.text} style={{ fontSize: 13, color: C.text }}>
            <span style={{ color: C.amber }}>&gt;</span> {item.text}
            {item.muted ? (
              <span style={{ color: '#8f8f85' }}> {item.muted}</span>
            ) : null}
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: 24,
          border: '1px solid rgba(242,193,78,.4)',
          borderRadius: 9,
          padding: '16px 16px 15px',
          background: 'rgba(242,193,78,.03)',
        }}
      >
        <div
          style={{
            color: C.amber,
            fontSize: 12.5,
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          why engineers run Gozzle
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {REASONS.map((reason) => (
            <div
              key={reason}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 10,
                fontSize: 13,
                color: C.text,
              }}
            >
              <span style={{ color: C.green, fontWeight: 700 }}>☑</span>
              {reason}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
