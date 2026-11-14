import * as React from 'react';
import * as UI from '@old/ui';

export const Banner: React.FC<{ message: string }> = ({ message }) => (
  <UI.Card title={message}>
    <UI.Button variant="danger" size="sm">Dismiss</UI.Button>
  </UI.Card>
);
