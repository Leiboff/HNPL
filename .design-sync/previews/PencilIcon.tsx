import { PencilIcon } from 'hnpl';

export function Icon() {
  return (
    <div style={{ padding: 24, display: 'inline-flex' }}>
      <div style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 80, height: 80, borderRadius: 18,
        background: 'rgba(21,168,158,0.10)', color: '#13294B',
      }}>
        <span style={{ display: 'flex', transform: 'scale(1.9)' }}><PencilIcon /></span>
      </div>
    </div>
  );
}
