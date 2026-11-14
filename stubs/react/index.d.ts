// Minimal React typings so the exercise type-checks offline.
export type ReactNode = string | number | boolean | null | undefined | JSX.Element | ReactNode[];
export interface FC<P = {}> {
  (props: P & { children?: ReactNode }): JSX.Element | null;
}
export interface ButtonHTMLAttributes<T> {
  onClick?: (e?: unknown) => void;
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
}
export type ComponentProps<T> = T extends (props: infer P) => any ? P : never;
export function useState<S>(initial: S): [S, (value: S) => void];
declare global {
  namespace JSX {
    interface Element {}
    interface IntrinsicElements { [tag: string]: any }
  }
}
