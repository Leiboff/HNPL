// design-sync shim: renders Next's <Link> as a plain anchor so brand
// components that import 'next/link' bundle + render outside a Next app.
import * as React from 'react';

type Href = string | { pathname?: string };

export default function Link({
  href,
  children,
  ...rest
}: { href?: Href; children?: React.ReactNode } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const to = typeof href === 'string' ? href : href?.pathname ?? '#';
  return (
    <a href={to} {...rest}>
      {children}
    </a>
  );
}
