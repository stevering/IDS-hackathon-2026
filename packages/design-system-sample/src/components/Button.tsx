import React from 'react';
import type { ButtonHTMLAttributes } from 'react';
import '../index.css'; // Tokens

/**
 * Figma Button 100% - https://figma.com/design/...node-id=2183-24086
 * Variants: Brand/Gray/Danger/Subtle x L/S x Default/Hover/Disabled
 */

export type ButtonVariant = 'Brand' | 'Gray' | 'Danger' | 'Subtle';
export type ButtonState = 'Default' | 'Hover' | 'Disabled';
export type ButtonSize = 'Large' | 'Small'; // Figma L/S

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
  size = 'Large',
  state = 'Default',
  variant = 'Brand',
  hasIconStart = false,
  hasIconEnd = false,
  iconStart,
  iconEnd,
  disabled = state === 'Disabled',
  ...props
}) => {
  const paddingClass = size === 'Large' 
    ? 'pl-4 pr-4 pt-2 pb-2'  // 16/16/8/8px Figma L
    : 'pl-3 pr-3 pt-1 pb-1'; // 12/12/4/4px S

  const textColorClass = (() => {
    if (state === 'Disabled') return 'text-[#b3b3b3]';
    if (['Brand', 'Danger'].includes(variant)) return 'text-white';
    return 'text-[#1e1e1e]';
  })();

  const textClass = `font-['Inter'] font-semibold text-base leading-tight ${textColorClass}`;

  const variantClass = (() => {
    const base = `inline-flex items-center justify-center gap-2 rounded-lg border-solid ${paddingClass} transition-all duration-200 hover:shadow-md`;

    const variants: Record<string, string> = {
      // Brand (Figma blue)
      'Brand/Default': 'bg-[#027be8] border-[#027be8]',
      'Brand/Hover': 'bg-[#025ab2] border-[#027be8]',
      'Brand/Disabled': 'bg-[#d9d9d9] border-[#b3b3b3]',
      // Danger (Figma red)
      'Danger/Default': 'bg-[#ef4444] border-[#ef4444]',
      'Danger/Hover': 'bg-[#dc2626] border-[#ef4444]',
      'Danger/Disabled': 'bg-[#d9d9d9] border-[#b3b3b3]',
      // Gray (Figma neutral)
      'Gray/Default': 'bg-transparent border-[#6b7280]',
      'Gray/Hover': 'bg-[#9ca3af] border-[#6b7280]',
      'Gray/Disabled': 'bg-[#d9d9d9] border-[#b3b3b3]',
      // Subtle (ghost)
      'Subtle/Default': 'bg-transparent border-transparent',
      'Subtle/Hover': 'bg-[#f3f4f6] border-[#d1d5db]',
      'Subtle/Disabled': 'bg-[#d9d9d9] border-[#b3b3b3]',
    };
    const key = `${variant}/${state}`;
    return `${base} ${variants[key] || variants['Brand/Default']}`;
  })();

  return (
    <button
      className={`${variantClass} ${className}`}
      disabled={disabled}
      {...props}
    >
      {hasIconStart && (iconStart || <span className="w-4 h-4">⭐</span>)}
      <span className={textClass}>{label}</span>
      {hasIconEnd && (iconEnd || <span className="w-4 h-4">✕</span>)}
    </button>
  );
};

export default Button;
