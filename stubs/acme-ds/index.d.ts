import * as React from 'react';
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: 'brand' | 'neutral' | 'critical';
  size?: 'small' | 'medium' | 'large';
  fullWidth?: boolean;
}
export const Button: React.FC<ButtonProps>;
export const Badge: React.FC<{}>;
