import PracticeHeader from './PracticeHeader';
import PracticeNav from './PracticeNav';

type Props = {
  practiceName: string;
  children: React.ReactNode;
};

export default function PracticeShell({ practiceName, children }: Props) {
  return (
    <div className="min-h-screen bg-[#f7fbfb]">
      <PracticeHeader practiceName={practiceName} />
      <div className="flex">
        <PracticeNav />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  );
}
