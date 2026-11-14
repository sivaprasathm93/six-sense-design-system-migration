import * as React from 'react';

export const Legend: React.FC = () => (
  <ul style={{ color: '#202124', borderColor: "#DADCE0" }}>
    <li style={{ background: '#E8F0FE' }}>Primary</li>
    <li className="dot" data-target="#bad">Danger</li>
  </ul>
);
