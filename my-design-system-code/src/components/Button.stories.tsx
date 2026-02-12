import type { Meta, StoryObj } from '@storybook/react';
import Button from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: { control: 'select', options: ['Primary', 'Neutral', 'Subtle'] },
    state: { control: 'select', options: ['Default', 'Hover', 'Disabled'] },
    size: { control: 'select', options: ['Medium', 'Small'] },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { variant: "Subtle", label: 'Primary' },
};

export const AllVariants: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-4 p-8">
      {(['Primary', 'Neutral', 'Subtle'] as const).map((variant) =>
        (['Default', 'Hover', 'Disabled'] as const).map((state) =>
          (['Medium', 'Small'] as const).map((size) => (
            <Button key={`${variant}-${state}-${size}`} variant={variant} state={state} size={size} label={`${variant} ${state} ${size}`} />
          ))
        )
      )}
    </div>
  ),
};
