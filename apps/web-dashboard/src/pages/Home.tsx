import * as React from 'react';
import { Card } from '@old/ui';
import { Button } from '@acme/ds';

export const Home: React.FC = () => {
  const [count, setCount] = React.useState(0);
  return (
    <Card title="Dashboard">
      <Button intent="brand" size="medium" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </Button>
      <Button
        intent="neutral"
        size="small"
        fullWidth
        disabled={count > 5}
      >
        Reset
      </Button>
      <Button size='large' intent='critical' fullWidth={true}>Delete all</Button>
      <Button>Default</Button>
    </Card>
  );
};
