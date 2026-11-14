import * as React from 'react';
import { Button, Card } from '@old/ui';

export const Home: React.FC = () => {
  const [count, setCount] = React.useState(0);
  return (
    <Card title="Dashboard">
      <Button variant="primary" size="md" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </Button>
      <Button
        variant="secondary"
        size="sm"
        block
        disabled={count > 5}
      >
        Reset
      </Button>
      <Button size='lg' variant='danger' block={true}>Delete all</Button>
      <Button>Default</Button>
    </Card>
  );
};
