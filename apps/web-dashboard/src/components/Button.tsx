import * as React from 'react';

// Local component. It is NOT the legacy library button.
export interface LocalButtonProps {
  variant?: 'primary' | 'link';
  label: string;
}

export const Button: React.FC<LocalButtonProps> = ({ variant = 'primary', label }) => (
  <button className={`btn btn-${variant}`}>{label}</button>
);
