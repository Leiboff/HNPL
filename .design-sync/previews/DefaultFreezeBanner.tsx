import { DefaultFreezeBanner } from 'hnpl';

export function Frozen() {
  return (
    <div style={{ maxWidth: 580, padding: 20 }}>
      <DefaultFreezeBanner frozen />
    </div>
  );
}
