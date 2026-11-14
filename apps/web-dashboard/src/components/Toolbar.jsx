import React from 'react';
import { Button } from '@old/ui';

export function Toolbar({ onRefresh }) {
  return (
    <div className="toolbar">
      {/* Button variant="primary" is documented in the design guide; leave this comment alone */}
      <Button variant="primary" size="sm" onClick={onRefresh}>Refresh</Button>
    </div>
  );
}
