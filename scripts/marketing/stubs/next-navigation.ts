// next/navigation for the static render: the Home tab is the active one.
export const useRouter = () => ({ push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {} });
export const usePathname = () => '/patient';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export function redirect(to: string): never { throw new Error(`capture: unexpected redirect to ${to}`); }
export function notFound(): never { throw new Error('capture: unexpected notFound()'); }
