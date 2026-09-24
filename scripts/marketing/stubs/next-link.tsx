// next/link as a plain anchor — the static render has no router.
import type { AnchorHTMLAttributes, ReactNode } from 'react';

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  href:      string | { pathname?: string };
  children?: ReactNode;
  prefetch?: boolean | null;
};

export default function Link({ href, children, prefetch, ...rest }: LinkProps) {
  void prefetch; // a router hint; meaningless on a plain anchor
  const to = typeof href === 'string' ? href : href.pathname ?? '#';
  return <a href={to} {...rest}>{children}</a>;
}
