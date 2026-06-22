import { JetBrains_Mono } from 'next/font/google';

export const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});

// Terminal palette shared across the marketing pages.
export const C = {
  bg: '#0d0d0d',
  amber: '#f2c14e',
  green: '#7fdf8a',
  red: '#ff7a6e',
  text: '#dcdcd2',
  textSoft: '#c8c8be',
  muted: '#6b6b62',
  comment: '#6b6b62',
};

export const GOOSE = `   __
 <(o )___
  ( ._> /
   \`---' `;

export const GITHUB_URL = 'https://github.com/lureilly1/gozzle';

export const INSTALL_COMMAND = 'npm install -g @gozzle/cli';
