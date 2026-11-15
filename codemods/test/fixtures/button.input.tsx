import * as React from 'react';
import { Button as LegacyButton, ButtonProps, Card } from '@old/ui';

type Props = { tone?: ButtonProps['variant'] };
type ButtonComponent = React.ComponentProps<typeof LegacyButton>;

export const Example = ({ tone }: Props) => (
  <Card><LegacyButton variant={tone} size='sm' block={true}>Go</LegacyButton></Card>
);
