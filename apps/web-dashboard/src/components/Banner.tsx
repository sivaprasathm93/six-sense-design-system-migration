import * as React from 'react';
import * as UI from '@old/ui';
import { Button } from '@acme/ds';

export const Banner: React.FC<{ message: string }> = ({ message }) => (
  <UI.Card title={message}>
    <Button intent="critical" size="small">Dismiss</Button>
  </UI.Card>
);
