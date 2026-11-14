import * as React from 'react';
import { Button as LegacyButton, Modal } from '@old/ui';

type Props = React.ComponentProps<typeof LegacyButton>;

export const SaveButton: React.FC<{ onSave: () => void }> = ({ onSave }) => (
  <LegacyButton variant="primary" onClick={onSave}>Save</LegacyButton>
);

export const PassThrough: React.FC<Props> = (props) => <LegacyButton {...props} />;

export const Cancel: React.FC<{ extra?: Props }> = ({ extra }) => (
  <LegacyButton {...extra} variant="secondary" size="sm">Cancel</LegacyButton>
);

export const Confirm: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => (
  <Modal open={open} onClose={onClose}>
    <LegacyButton variant="danger" onClick={onClose}>Close</LegacyButton>
  </Modal>
);
