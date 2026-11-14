import * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
}
export const Button: React.FC<ButtonProps>;
export const Card: React.FC<{ title?: string }>;
export const Modal: React.FC<{ open: boolean; onClose: () => void }>;
