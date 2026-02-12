import React from 'react';
import type { ButtonHTMLAttributes } from 'react';
import '../index.css'; // Import tokens

export type ButtonVariant = 'Primary' | 'Neutral' | 'Subtle';
export type ButtonState = 'Default' | 'Hover' | 'Disabled';
export type ButtonSize = 'Medium' | 'Small';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  className?: string;
  label?: string;
  size?: ButtonSize;
  state?: ButtonState;
  variant?: ButtonVariant;
  hasIconStart?: boolean;
  hasIconEnd?: boolean;
  iconStart?: React.ReactNode;
  iconEnd?: React.ReactNode;
}

const Button: React.FC<ButtonProps> = ({
  className = '',
  label = 'Button',
  size = 'Medium',
  state = 'Default',
  variant = 'Primary',
  hasIconStart = false,
  hasIconEnd = false,
  iconStart,
  iconEnd,
  disabled = state === 'Disabled',
  ...props
}) => {
  const paddingClass = size === 'Medium' ? 'p-[var(--sds-size-space-300,12px)]' : 'p-[var(--sds-size-space-200,8px)]';
  const textColorClass = (() => {
    if (state === 'Disabled') return 'text-[color:var(--sds-color-text-disabled-on-disabled,#b3b3b3)]';
    if (variant === 'Primary') return 'text-[color:var(--sds-color-text-brand-on-brand,#f5f5f5)]';
    if (variant === 'Subtle' && state === 'Default') return 'text-[color:var(--sds-color-text-neutral-default,#303030)]';
    return 'text-[color:var(--sds-color-text-default-default,#1e1e1e)]';
  })();

  const textClass = `font-[family-name:var(--sds-typography-body-font-family,'Inter:Regular',sans-serif)] font-[var(--sds-typography-body-font-weight-regular,400)] leading-none not-italic relative shrink-0 text-[length:var(--sds-typography-body-size-medium,16px)] ${textColorClass}`;

  const variantClass = (() => {
    const base = `inline-flex items-center justify-center gap-[var(--sds-size-space-200,8px)] overflow-hidden relative rounded-[var(--sds-size-radius-200,8px)] border border-solid ${paddingClass}`;
    
    const variants: Record<string, string> = {
      'Primary/Default': 'bg-[var(--sds-color-background-brand-default,#2c2c2c)] border-[var(--sds-color-border-brand-default,#2c2c2c)]',
      'Primary/Hover': 'bg-[var(--sds-color-background-brand-hover,#1e1e1e)] border-[var(--sds-color-border-brand-default,#2c2c2c)]',
      'Primary/Disabled': 'bg-[var(--sds-color-background-disabled-default,#d9d9d9)] border-[var(--sds-color-border-disabled-default,#b3b3b3)]',
      'Neutral/Default': 'bg-[var(--sds-color-background-neutral-tertiary,#e3e3e3)] border-[var(--sds-color-border-neutral-secondary,#767676)]',
      'Neutral/Hover': 'bg-[var(--sds-color-background-neutral-tertiary-hover,#cdcdcd)] border-[var(--sds-color-border-neutral-secondary,#767676)]',
      'Neutral/Disabled': 'bg-[var(--sds-color-background-disabled-default,#d9d9d9)] border-[var(--sds-color-border-disabled-default,#b3b3b3)]',
      'Subtle/Default': '',
      'Subtle/Hover': 'border-[var(--sds-color-border-default-default,#d9d9d9)]',
      'Subtle/Disabled': 'bg-[var(--sds-color-background-disabled-default,#d9d9d9)] border-[var(--sds-color-border-disabled-default,#b3b3b3)]',
    };

    const key = `${variant}/${state}`;
    return `${base} ${variants[key] || variants['Primary/Default']}`;
  })();

  return (
    <button
      className={`${variantClass} ${className}`}
      disabled={disabled}
      {...props}
    >
      {hasIconStart && (iconStart || <span className="shrink-0 w-4 h-4">⭐</span>)}
      <span className={textClass}>{label}</span>
      {hasIconEnd && (iconEnd || <span className="shrink-0 w-4 h-4">✕</span>)}
    </button>
  );
};

export default Button;
