import React from 'react';
import { Button } from '@acme/ds';

export function Toolbar({ onRefresh }) {
  return (
    <div className="toolbar">
      {/* Button variant="primary" is documented in the design guide; leave this comment alone */}
      <Button intent="brand" size="small" onClick={onRefresh}>Refresh</Button>
    </div>
  );
}
