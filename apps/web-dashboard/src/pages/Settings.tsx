import * as React from 'react';
import { Modal } from '@old/ui';
import { Button } from '@acme/ds';

type Props = React.ComponentProps<typeof Button>;

export const SaveButton: React.FC<{ onSave: () => void }> = ({ onSave }) => (
  <Button intent="brand" onClick={onSave}>Save</Button>
);

// TODO(ds-migration) spread-props `{...props}`: Spread props were retained; verify the object uses the new Button prop names and values. See report/REPORT.md.
export const PassThrough: React.FC<Props> = (props) => <Button {...props} />;

export const Cancel: React.FC<{ extra?: Props }> = ({ extra }) => (
  // TODO(ds-migration) spread-props `{...extra}`: Spread props were retained; verify the object uses the new Button prop names and values. See report/REPORT.md.
  <Button {...extra} intent="neutral" size="small">Cancel</Button>
);

export const Confirm: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => (
  <Modal open={open} onClose={onClose}>
    <Button intent="critical" onClick={onClose}>Close</Button>
  </Modal>
);
