// The landing page ships its own nav, terminal frame, and footer, so it renders
// without the shared Fumadocs HomeLayout chrome.
export default function Layout({ children }: LayoutProps<'/'>) {
  return <>{children}</>;
}
