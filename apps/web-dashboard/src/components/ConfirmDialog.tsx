import * as React from 'react';
import { Button, ButtonProps } from '@acme/ds';

interface Props {
  destructive: boolean;
  tone?: ButtonProps['intent'];
  onConfirm: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({ destructive, tone, onConfirm }) => (
  <div>
    <Button intent={destructive ? 'critical' : 'brand'} onClick={onConfirm}>
      Confirm
    </Button>
    <Button intent={tone}>Other</Button>
  </div>
);
