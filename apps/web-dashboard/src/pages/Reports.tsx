import * as React from 'react';
import { Badge } from '@acme/ds';
import { Button } from '@old/ui';

export const Reports: React.FC = () => (
  <div>
    <Badge>New</Badge>
    <Button variant="secondary" size="lg">Export</Button>
  </div>
);
