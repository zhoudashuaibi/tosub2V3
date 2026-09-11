import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * 尺寸基线（与 input / select 对齐，避免同一行控件高度不一）：
 *   default h-8 / sm h-7 / lg h-9 / icon size-8。
 * 触控目标不小于 32px（sm 为 28px，仅用于表格行内等密集区域）。
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-transparent text-sm font-medium transition-[background-color,border-color,color,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 active:translate-y-px [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-[0_1px_0_rgb(255_255_255_/_0.18)_inset] hover:bg-primary/85',
        destructive: 'bg-destructive text-destructive-foreground shadow-[0_1px_0_rgb(255_255_255_/_0.14)_inset] hover:bg-destructive/85',
        outline: 'border-input bg-card/50 hover:border-foreground/30 hover:bg-accent hover:text-accent-foreground',
        secondary: 'border-border bg-secondary text-secondary-foreground hover:border-foreground/25 hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2.5 text-xs',
        lg: 'h-9 px-4',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ComponentProps<'button'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}

export { Button, buttonVariants };
