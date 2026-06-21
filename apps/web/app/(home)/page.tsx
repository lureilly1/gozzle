import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="flex flex-col justify-center items-center text-center flex-1 gap-4 px-4">
      <h1 className="text-3xl font-bold">Gozzle</h1>
      <p className="text-fd-muted-foreground max-w-md">
        A local safety harness and developer toolkit for ClickHouse. This site
        is a placeholder — documentation is coming soon.
      </p>
      <p>
        Head to{' '}
        <Link href="/docs" className="font-medium underline">
          /docs
        </Link>{' '}
        to get started.
      </p>
      <p className="text-fd-muted-foreground text-sm">
        <Link href="/docs/privacy" className="underline">
          Privacy
        </Link>
      </p>
    </div>
  );
}
