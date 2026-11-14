import * as React from 'react';
import { Button, ButtonProps } from '@old/ui';

interface Props {
  destructive: boolean;
  tone?: ButtonProps['variant'];
  onConfirm: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({ destructive, tone, onConfirm }) => (
  <div>
    <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
      Confirm
    </Button>
    <Button variant={tone}>Other</Button>
  </div>
);
