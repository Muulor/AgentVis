type ClassValue = string | false | null | undefined;

export function cx(...classes: ClassValue[]): string {
  return classes
    .filter(
      (className): className is string => typeof className === 'string' && className.length > 0
    )
    .join(' ');
}
