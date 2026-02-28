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
    variant: { 
      control: 'select', 
      options: ['Brand', 'Gray', 'Danger', 'Subtle']
    },
    size: { 
      control: 'select', 
      options: ['Large', 'Small'] 
    },
    state: { 
      control: 'select', 
      options: ['Default', 'Hover', 'Disabled'] 
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Templates individuels
export const BrandLarge: Story = {
  args: { variant: 'Brand', size: 'Large', label: 'Brand L' },
};

export const DangerSmall: Story = {
  args: { variant: 'Danger', size: 'Small', label: 'Danger S' },
};

// ALL Figma combos (3x2x3 = 18)
export const AllVariants: Story = {
  render: () => (
    <div className="grid grid-cols-3 gap-4 p-8 max-w-4xl">
      {(['Brand', 'Gray', 'Danger', 'Subtle'] as const).map((variant) =>
        (['Large', 'Small'] as const).map((size) =>
          (['Default', 'Hover', 'Disabled'] as const).map((state) => (
            <div key={`${variant}-${size}-${state}`} className="flex flex-col items-center gap-1 p-2 bg-gray-50 rounded">
              <Button 
                variant={variant} 
                size={size} 
                state={state} 
                label={`${variant} ${size} ${state}`} 
              />
              <small className="text-xs opacity-75">{variant}-{size}-{state}</small>
            </div>
          ))
        )
      )}
    </div>
  ),
};
