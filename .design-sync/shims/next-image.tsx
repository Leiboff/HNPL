// design-sync shim: Next <Image> as a plain <img>.
import * as React from 'react';

export default function Image({
  src,
  alt = '',
  ...rest
}: { src?: string | { src: string }; alt?: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const s = typeof src === 'string' ? src : src?.src;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={s} alt={alt} {...rest} />;
}
