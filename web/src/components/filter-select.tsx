import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const ALL_VALUE = '__all__';

export function FilterSelect({
  value,
  onValueChange,
  label,
  options,
  className,
  size = 'default',
}: {
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  className?: string;
  size?: 'sm' | 'default';
}) {
  return (
    <Select value={value || ALL_VALUE} onValueChange={(next) => onValueChange(next === ALL_VALUE ? '' : next)}>
      <SelectTrigger size={size} className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL_VALUE}>{label}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
