import { ApprovedBalanceCard } from 'hnpl';

export function Default() {
  return (
    <div style={{ maxWidth: 440, padding: 20 }}>
      <ApprovedBalanceCard limit={8000} available={5250} />
    </div>
  );
}
