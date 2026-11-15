import * as React from 'react';

export const Legend: React.FC = () => (
  <ul style={{ color: 'var(--color-gray-900)', borderColor: "var(--color-gray-300)" }}>
    <li style={{ background: 'var(--color-blue-100)' }}>Primary</li>
    <li className="dot" data-target="#bad">Danger</li>
  </ul>
);
