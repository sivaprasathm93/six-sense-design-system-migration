import * as React from 'react';
import { Card } from '@old/ui';
import { Button, ButtonProps } from '@acme/ds';

type Props = { tone?: ButtonProps['intent'] };
type ButtonComponent = React.ComponentProps<typeof Button>;

export const Example = ({ tone }: Props) => (
  <Card><Button intent={tone} size='small' fullWidth={true}>Go</Button></Card>
);
