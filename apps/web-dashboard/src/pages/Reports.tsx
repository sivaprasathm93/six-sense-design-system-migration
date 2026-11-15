import * as React from 'react';
import { Badge, Button } from '@acme/ds';

export const Reports: React.FC = () => (
  <div>
    <Badge>New</Badge>
    <Button intent="neutral" size="large">Export</Button>
  </div>
);
